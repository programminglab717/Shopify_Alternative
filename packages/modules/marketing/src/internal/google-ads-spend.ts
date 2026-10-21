// What Hatti asks Google of a shop's Google Ads account (ADR-678): the grant its owner gives Hatti
// on Google's consent screen, the account as Google names it, and each day's spend on each of its
// campaigns, through the Google Ads API's searchStream with Hatti's developer token. Google's
// paths, statuses and limits are here alone.
import type { AdAccountFacts, CampaignDay } from './ad-account-pull.js';

/** The scope of the grant: reading and managing the owner's Google Ads accounts. */
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

/** Where the Google Ads API and Google's OAuth are, and Hatti's own credentials for them. */
export interface GoogleAdsOptions {
  /** https://googleads.googleapis.com, unless a test says otherwise. */
  baseUrl: string;
  /** The Google Ads API's version, "v21". */
  version: string;
  /** Google's consent screen: https://accounts.google.com/o/oauth2/v2/auth. */
  authorizeUrl: string;
  /** Where codes and refresh tokens are exchanged: https://oauth2.googleapis.com/token. */
  tokenUrl: string;
  /** Hatti's developer token for the Google Ads API; none where Hatti has not set one up. */
  developerToken?: string;
  /** Hatti's OAuth client, of a web application, whose consent screen the owner sees. */
  clientId?: string;
  clientSecret?: string;
  /** How long a request may take; ten seconds unless given. */
  timeoutMs?: number;
}

/** A Google Ads account as Google shows it. */
export type GoogleAdsCustomerFacts = AdAccountFacts;

/** What one campaign spent on a day, as Google reports it. */
export type GoogleAdsCampaignDay = CampaignDay;

/**
 * What Google said: what was asked for, or why not. `token`: it refused the grant, or the grant may
 * not read the account; `account`: it has no such account, or it is not one that serves ads;
 * `busy`: it could not answer now, or limits the requests for now; `other`: anything else, Hatti's
 * own developer token among it.
 */
export type GoogleAdsResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'token' | 'account' | 'busy' | 'other'; message: string };

/** The ten digits of a customer ID, as Google Ads shows it, "123-456-7890"; null for anything else. */
export function customerIdOf(value: string): string | null {
  const id = value.replace(/[\s-]/g, '');
  return /^[0-9]{10}$/.test(id) ? id : null;
}

/** "123-456-7890", as Google Ads shows the ID. */
export function customerIdShown(id: string): string {
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;
}

/** Micros of a currency, Google's int64 as a string, in major units: "1500500000" → "1500.500000". */
export function microsToSpend(micros: string): string | null {
  if (!/^[0-9]{1,19}$/.test(micros)) return null;
  const padded = micros.padStart(7, '0');
  return `${BigInt(padded.slice(0, -6))}.${padded.slice(-6)}`;
}

/** Google Ads' errors, as best known, that are the account's rather than the grant's. */
const ACCOUNT_ERRORS = new Set([
  'CUSTOMER_NOT_FOUND',
  'CUSTOMER_NOT_ENABLED',
  'NOT_ADS_USER',
  'REQUESTED_METRICS_FOR_MANAGER',
]);

/**
 * Reads shops' Google Ads accounts (ADR-678): the grant's refresh token is exchanged for an access
 * token each time, which is never kept.
 */
export class GoogleAdsClient {
  constructor(private readonly options: GoogleAdsOptions) {}

  /** Whether Hatti has its developer token and OAuth client for Google Ads. */
  get configured(): boolean {
    const { developerToken, clientId, clientSecret } = this.options;
    return Boolean(developerToken && clientId && clientSecret);
  }

  /**
   * Google's consent screen, for the owner to grant Hatti the reading of their Google Ads
   * accounts, coming back to `redirectUri` with a code and `state` as given; null where Hatti has
   * not set Google Ads up. The grant is asked for offline, with consent each time, so that Google
   * gives a refresh token.
   */
  consentUrl(redirectUri: string, state: string): string | null {
    if (!this.configured) return null;
    const query = new URLSearchParams({
      client_id: this.options.clientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_ADS_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${this.options.authorizeUrl}?${query}`;
  }

  /** The refresh token of the grant whose `code` came back to `redirectUri`. */
  async grant(code: string, redirectUri: string): Promise<GoogleAdsResult<string>> {
    const result = await this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    if (!result.ok) return result;
    const refresh = result.value.refresh_token;
    if (typeof refresh !== 'string' || !refresh) {
      return {
        ok: false,
        kind: 'token',
        message: 'Google gave no lasting grant: connect again, and allow access when asked',
      };
    }
    return { ok: true, value: refresh };
  }

  /** The account, as Google names it, if the grant may read it. */
  async customer(
    customerId: string,
    refreshToken: string,
  ): Promise<GoogleAdsResult<GoogleAdsCustomerFacts>> {
    const result = await this.#search(
      customerId,
      refreshToken,
      'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, ' +
        'customer.manager FROM customer LIMIT 1',
    );
    if (!result.ok) return result;
    const customer = result.value[0]?.customer as Record<string, unknown> | undefined;
    if (!customer) {
      return { ok: false, kind: 'account', message: 'Google has no such Google Ads account' };
    }
    if (customer.manager === true) {
      return {
        ok: false,
        kind: 'account',
        message: 'This is a manager account: give the ID of the account that runs the ads',
      };
    }
    const { descriptiveName: name, currencyCode: currency, timeZone: timezone } = customer;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, kind: 'other', message: 'Google gave no currency for the account' };
    }
    return {
      ok: true,
      value: {
        name:
          typeof name === 'string' && name.trim()
            ? name.trim().slice(0, 200)
            : customerIdShown(customerId),
        currency,
        timezone:
          typeof timezone === 'string' && timezone && timezone.length <= 100 ? timezone : null,
      },
    };
  }

  /**
   * What each of the account's campaigns spent on each day from `since` to `until`, both
   * included, in the account's time zone, as Google streams them. Days a campaign spent nothing
   * on are left out.
   */
  async spend(
    customerId: string,
    refreshToken: string,
    since: string,
    until: string,
  ): Promise<GoogleAdsResult<GoogleAdsCampaignDay[]>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return { ok: false, kind: 'other', message: 'The days asked for are not dates' };
    }
    const result = await this.#search(
      customerId,
      refreshToken,
      'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros FROM campaign ' +
        `WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.cost_micros > 0`,
    );
    if (!result.ok) return result;
    const days: GoogleAdsCampaignDay[] = [];
    for (const row of result.value) {
      const campaign = row.campaign as Record<string, unknown> | undefined;
      const day = (row.segments as Record<string, unknown> | undefined)?.date;
      const micros = (row.metrics as Record<string, unknown> | undefined)?.costMicros;
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const spend = microsToSpend(typeof micros === 'number' ? `${micros}` : `${micros ?? ''}`);
      if (spend === null) continue;
      const name = campaign?.name;
      const id = campaign?.id;
      days.push({
        day,
        // A campaign Google gives no name is its ID: never the platform's whole day.
        campaign:
          typeof name === 'string' && name.trim()
            ? name
            : typeof id === 'string' || typeof id === 'number'
              ? `${id}`
              : '',
        spend,
      });
    }
    return { ok: true, value: days };
  }

  /** The rows Google streams for `query` on the account, with an access token from the grant. */
  async #search(
    customerId: string,
    refreshToken: string,
    query: string,
  ): Promise<GoogleAdsResult<Record<string, unknown>[]>> {
    if (!this.configured) {
      return { ok: false, kind: 'other', message: 'Google Ads is not set up on this Hatti' };
    }
    const access = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (!access.ok) return access;
    const token = access.value.access_token;
    if (typeof token !== 'string' || !token) {
      return { ok: false, kind: 'other', message: 'Google gave no access token' };
    }
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = `${base}/${this.options.version}/customers/${customerId}/googleAds:searchStream`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'developer-token': this.options.developerToken!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'busy',
        message: `Google Ads could not be reached: ${(error as Error).message}`,
      };
    }
    const json = (await response.json().catch(() => null)) as unknown;
    if (response.ok) {
      // A stream of batches, each with its results.
      const batches = Array.isArray(json) ? json : [json];
      const rows = batches.flatMap((batch) => {
        const results = (batch as { results?: unknown } | null)?.results;
        return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
      });
      return { ok: true, value: rows };
    }
    return this.#refused(response.status, Array.isArray(json) ? json[0] : json);
  }

  /** Google's answer to a refused search, sorted as {@link GoogleAdsResult} says. */
  #refused(status: number, json: unknown): GoogleAdsResult<never> {
    const error = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
    const said = (
      typeof error.message === 'string' && error.message.trim()
        ? error.message
        : `Google Ads answered ${status}`
    )
      .trim()
      .slice(0, 500);
    // Each detail's errors name what went wrong as { group: 'CODE' }.
    const codes = new Set<string>();
    for (const detail of Array.isArray(error.details) ? error.details : []) {
      const errors = (detail as { errors?: unknown } | null)?.errors;
      for (const each of Array.isArray(errors) ? errors : []) {
        const code = (each as { errorCode?: Record<string, unknown> } | null)?.errorCode ?? {};
        for (const value of Object.values(code)) if (typeof value === 'string') codes.add(value);
      }
    }
    if ([...codes].some((code) => ACCOUNT_ERRORS.has(code)) || status === 404) {
      return { ok: false, kind: 'account', message: `Google Ads refused the account: ${said}` };
    }
    if (codes.has('DEVELOPER_TOKEN_NOT_APPROVED') || codes.has('DEVELOPER_TOKEN_PROHIBITED')) {
      return { ok: false, kind: 'other', message: `Google Ads refused Hatti: ${said}` };
    }
    if (status === 401 || status === 403) {
      return { ok: false, kind: 'token', message: `Google refused the grant: ${said}` };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, kind: 'busy', message: `Google Ads could not answer just now: ${said}` };
    }
    return { ok: false, kind: 'other', message: `Google Ads refused it: ${said}` };
  }

  /** Google's token endpoint, for a refresh token or an access token. */
  async #token(
    form: Record<string, string>,
  ): Promise<GoogleAdsResult<{ access_token?: unknown; refresh_token?: unknown }>> {
    if (!this.configured) {
      return { ok: false, kind: 'other', message: 'Google Ads is not set up on this Hatti' };
    }
    let response: Response;
    try {
      response = await fetch(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...form,
          client_id: this.options.clientId!,
          client_secret: this.options.clientSecret!,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'busy',
        message: `Google could not be reached: ${(error as Error).message}`,
      };
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && json) return { ok: true, value: json };
    const reason = typeof json?.error === 'string' ? json.error : null;
    const said = (
      typeof json?.error_description === 'string' && json.error_description.trim()
        ? json.error_description
        : (reason ?? `Google answered ${response.status}`)
    )
      .trim()
      .slice(0, 500);
    // A code used, expired or not this client's, or a grant the owner took back.
    if (reason === 'invalid_grant') {
      return { ok: false, kind: 'token', message: `Google refused the grant: ${said}` };
    }
    if (response.status === 429 || response.status >= 500) {
      return { ok: false, kind: 'busy', message: `Google could not answer just now: ${said}` };
    }
    return { ok: false, kind: 'other', message: `Google refused Hatti's sign-in: ${said}` };
  }
}
