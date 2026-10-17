// What Hatti asks Meta's Marketing API of a shop's ad account (ADR-564), with the token the shop
// gave it: the account as Meta names it, and each day's spend on each of its campaigns.
import type { MetaGraphOptions } from './meta-client.js';

/** The most pages of a span's spend asked for, 500 campaign days each, before giving up on it. */
export const META_INSIGHTS_PAGES = 20;

/** An ad account as Meta shows it. */
export interface MetaAdAccountFacts {
  name: string;
  /** What it bills in, "PKR". */
  currency: string;
  /** The time zone its days are reported in, "Asia/Karachi"; null when Meta gave none. */
  timezone: string | null;
}

/** What one campaign spent on a day, as Meta reports it. */
export interface MetaCampaignDay {
  /** In the ad account's time zone, `YYYY-MM-DD`. */
  day: string;
  campaign: string;
  /** In the account's currency, as Meta writes it: "1234.56". */
  spend: string;
}

/**
 * What Meta said: what was asked for, or why not. `token`: it refused the token, or the token
 * may not read the account; `account`: it has no such account; `busy`: it could not answer now,
 * or limits the account's requests for now; `other`: anything else.
 */
export type MetaAdsResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'token' | 'account' | 'busy' | 'other'; message: string };

/** The Graph API error a request was refused with. */
interface GraphError {
  message?: string;
  code?: number;
  type?: string;
  is_transient?: boolean;
  error_user_msg?: string;
}

/**
 * Errors of the token: expired, revoked or changed (190, 102), or without ads_read on the account
 * (10, 200 to 299) (https://developers.facebook.com/docs/graph-api/guides/error-handling).
 */
const TOKEN = new Set([10, 102, 190]);

/** Meta busy, or the account's requests over their limits for now; 80000 on are the ads API's. */
const BUSY = new Set([1, 2, 4, 17, 32, 341, 613]);

/** The ID as Ads Manager shows it, "act_123456789" or its digits; null for anything else. */
export function adAccountIdOf(value: string): string | null {
  const id = value.replace(/\s/g, '').replace(/^act_/i, '');
  return /^[0-9]{5,20}$/.test(id) ? id : null;
}

/**
 * `spend`, a decimal Meta wrote in major units, in minor units of a currency with `exponent`
 * decimal places, rounded half up; null for anything else.
 */
export function spendMinor(spend: string, exponent: number): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(spend.trim());
  if (!match) return null;
  const [, whole = '0', fraction = ''] = match;
  const minor = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, '0'));
  return (fraction[exponent] ?? '0') >= '5' ? minor + 1n : minor;
}

/** Reads shops' ad accounts from Meta's Marketing API, on the Graph API (ADR-564). */
export class MetaAdsClient {
  constructor(private readonly options: MetaGraphOptions) {}

  /** The account, as Meta names it, if the token may read it. */
  async account(adAccountId: string, token: string): Promise<MetaAdsResult<MetaAdAccountFacts>> {
    const result = await this.#get<{ name?: unknown; currency?: unknown; timezone_name?: unknown }>(
      `${this.#base()}/act_${adAccountId}?fields=name,currency,timezone_name,account_status`,
      token,
    );
    if (!result.ok) return result;
    const { name, currency, timezone_name: timezone } = result.value;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, kind: 'other', message: 'Meta gave no currency for the ad account' };
    }
    return {
      ok: true,
      value: {
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : adAccountId,
        currency,
        timezone:
          typeof timezone === 'string' && timezone && timezone.length <= 100 ? timezone : null,
      },
    };
  }

  /**
   * What each of the account's campaigns spent on each day from `since` to `until`, both
   * included, in the account's time zone, page after page as Meta gives them. Days a campaign
   * spent nothing on may be left out.
   */
  async spend(
    adAccountId: string,
    token: string,
    since: string,
    until: string,
  ): Promise<MetaAdsResult<MetaCampaignDay[]>> {
    const query = new URLSearchParams({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      fields: 'campaign_name,spend,date_start',
      limit: '500',
    });
    const origin = new URL(this.#base()).origin;
    let url: string | null = `${this.#base()}/act_${adAccountId}/insights?${query}`;
    const days: MetaCampaignDay[] = [];
    for (let page = 0; url; page++) {
      if (page === META_INSIGHTS_PAGES) {
        return {
          ok: false,
          kind: 'other',
          message: `Meta gave more than ${META_INSIGHTS_PAGES} pages of campaigns' days`,
        };
      }
      const result: MetaAdsResult<{ data?: unknown; paging?: { next?: unknown } }> =
        await this.#get(url, token);
      if (!result.ok) return result;
      for (const row of Array.isArray(result.value.data) ? result.value.data : []) {
        const {
          campaign_name: campaign,
          spend,
          date_start: day,
        } = (row ?? {}) as Record<string, unknown>;
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (typeof spend !== 'string' && typeof spend !== 'number') continue;
        days.push({
          day,
          campaign: typeof campaign === 'string' ? campaign : '',
          spend: `${spend}`,
        });
      }
      const next: unknown = result.value.paging?.next;
      // The token goes in a header, and only ever to the Graph API itself.
      url =
        typeof next === 'string' && URL.canParse(next) && new URL(next).origin === origin
          ? next
          : null;
    }
    return { ok: true, value: days };
  }

  #base(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/${this.options.version}`;
  }

  /** GETs `url` with the token in a header, so that no log of addresses keeps it. */
  async #get<T>(url: string, token: string): Promise<MetaAdsResult<T>> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'busy',
        message: `Meta could not be reached: ${(error as Error).message}`,
      };
    }
    const json = (await response.json().catch(() => null)) as (T & { error?: GraphError }) | null;
    if (response.ok && json && !json.error) return { ok: true, value: json };
    const error = json?.error ?? {};
    const code = error.code ?? 0;
    const said = (error.error_user_msg || error.message || `Meta answered ${response.status}`)
      .trim()
      .slice(0, 500);
    if (TOKEN.has(code) || (code >= 200 && code <= 299) || response.status === 401) {
      return { ok: false, kind: 'token', message: `Meta refused the token: ${said}` };
    }
    if (
      BUSY.has(code) ||
      (code >= 80_000 && code <= 80_099) ||
      error.is_transient === true ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return { ok: false, kind: 'busy', message: `Meta could not answer just now: ${said}` };
    }
    if (code === 100 || code === 803 || response.status === 404) {
      return { ok: false, kind: 'account', message: `Meta has no such ad account: ${said}` };
    }
    return { ok: false, kind: 'other', message: `Meta refused it: ${said}` };
  }
}
