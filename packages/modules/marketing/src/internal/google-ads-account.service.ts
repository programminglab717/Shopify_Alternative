import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable, Optional } from '@nestjs/common';
import {
  AD_SPEND_PULL_GAP_MS,
  adAccountIn,
  adAccountKeptOf,
  adAccountsDue,
  deleteAdAccountIn,
  pullAdSpend,
  saveAdAccountIn,
  type AdAccountRow,
  type AdAccountTable,
  type AdSpendPull,
} from './ad-account-pull.js';
import {
  MarketingEvents,
  type GoogleAdsAccountConnectedPayload,
  type GoogleAdsAccountDisconnectedPayload,
} from './events.js';
import { GoogleAdsClient, customerIdOf } from './google-ads-spend.js';

/** Where shops' Google Ads accounts are kept, and their spend pulled to. */
const GOOGLE_ADS_ACCOUNTS: AdAccountTable = {
  platform: 'google',
  source: 'google_api',
  table: 'google_ads_accounts',
  idColumn: 'customer_id',
  idField: 'customerId',
  sealing: 'google-ads',
};

/** The longest code and address of the consent screen's return Hatti takes. */
const GRANT_LIMITS = { code: 512, redirectUri: 2_000, state: 500 } as const;

/** The shop's Google Ads account, as the Admin API shows it: never its grant. */
export interface GoogleAdsAccountRecord {
  /** Its ten digits, as Google Ads shows them without their dashes. */
  customerId: string;
  name: string;
  currency: string;
  /** The time zone Google reports its days in; null when Google gave none. */
  timezone: string | null;
  /** The last four characters of the grant's refresh token. */
  tokenHint: string;
  /** When its spend was last pulled; null before the first time. */
  lastSyncedAt: Date | null;
  /** Why the last pull failed; null when it went through. */
  lastError: string | null;
  updatedAt: Date;
}

export interface GoogleAdsAccountInput {
  /** Its ID, as Google Ads shows it: "123-456-7890". */
  customerId: string;
  /** The code Google's consent screen came back to `redirectUri` with. */
  code: string;
  /** The address the consent screen was asked to come back to, as asked. */
  redirectUri: string;
}

/** How pulling the shop's spend went: how many days it covered and entries it kept, or why not. */
export type GoogleAdsSpendPull = AdSpendPull;

/** An address the consent screen may come back to: https, or http on this machine. */
function redirectUriOf(value: string): string | null {
  if (value.length > GRANT_LIMITS.redirectUri) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The shop's Google Ads account (MKT-12, ADR-678), whose spend is pulled from the Google Ads API
 * each day by campaign, as a Meta ad account's is from Meta (ADR-564) and a TikTok advertiser's
 * from TikTok (ADR-566). Its owner grants Hatti the reading of their Google Ads accounts on
 * Google's consent screen, with Hatti's own OAuth client; the code it comes back with is exchanged
 * for the grant's refresh token, kept sealed and never shown again, and an access token is had
 * from it for each pull. Google is asked before anything is kept, and the account must bill in the
 * shop's currency, as its spend is kept in it. Connecting is audited, the grant never; a plan
 * without true profit connects none, keeping one connected before (ADR-523, ADR-529). Where Hatti
 * has no developer token and OAuth client for Google Ads, none connects.
 *
 * Each pull covers the last week, the shop's today among them, as Google revises its recent days;
 * the first, the last 30. Google reports days in the account's time zone, and each is kept as the
 * shop's day of that date, as Meta's are.
 */
@Injectable()
export class GoogleAdsAccountService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly client: GoogleAdsClient,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<GoogleAdsAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) =>
      adAccountIn(tx, GOOGLE_ADS_ACCOUNTS, tenant.shopId),
    );
    return row && toRecord(row);
  }

  /**
   * Google's consent screen, coming back to `redirectUri` with `state` as given, for the admin to
   * send the owner to; null where Hatti has not set Google Ads up, or the address is not one the
   * screen may come back to.
   */
  consentUrl(redirectUri: string, state: string): string | null {
    const uri = redirectUriOf(redirectUri);
    if (!uri || state.length > GRANT_LIMITS.state) return null;
    return this.client.consentUrl(uri, state);
  }

  /**
   * Connects the shop's Google Ads account, in place of any it had, or gives it another grant:
   * the consent screen's code is exchanged for the grant, and Google must say the grant reads the
   * account; then its spend is pulled, the last 30 days the first time. A pull that fails leaves
   * the account connected, saying why.
   */
  async connect(
    tenant: TenantContext,
    input: GoogleAdsAccountInput,
    at: Date = new Date(),
  ): Promise<MutationResult<GoogleAdsAccountRecord>> {
    const check = new InputChecker();
    const customerId = customerIdOf(input.customerId);
    if (!customerId) {
      check.add(
        ['input', 'customerId'],
        'INVALID',
        "must be the account's customer ID, as Google Ads shows it: ten digits, as 123-456-7890",
      );
    }
    const code = input.code.trim();
    if (!code || code.length > GRANT_LIMITS.code || !/^[!-~]+$/.test(code)) {
      check.add(['input', 'code'], 'INVALID', "must be the code Google's consent screen gave");
    }
    const redirectUri = redirectUriOf(input.redirectUri.trim());
    if (!redirectUri) {
      check.add(
        ['input', 'redirectUri'],
        'INVALID',
        "must be the https address Google's consent screen came back to",
      );
    }
    if (!check.ok || !customerId || !redirectUri) return { ok: false, errors: check.errors };
    if (!this.client.configured) {
      return failOne(['base'], 'UNAVAILABLE', 'Google Ads is not set up on this Hatti');
    }
    const existing = await this.get(tenant);
    const plan = existing ? null : await this.allowance?.excludes(tenant.shopId, 'trueProfit');
    if (plan) {
      return failOne(
        ['input'],
        'INVALID',
        planFeatureMessage(plan, 'true profit', "connect Google's ad spend"),
      );
    }

    const grant = await this.client.grant(code, redirectUri);
    if (!grant.ok) {
      return failOne(
        ['input', 'code'],
        grant.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID',
        grant.message,
      );
    }
    const customer = await this.client.customer(customerId, grant.value);
    if (!customer.ok) {
      return failOne(
        customer.kind === 'account' ? ['input', 'customerId'] : ['input', 'code'],
        customer.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID',
        customer.message,
      );
    }
    if (customer.value.currency !== tenant.currency) {
      const ours = tenant.currency === 'PKR' ? 'rupees' : tenant.currency;
      return failOne(
        ['input', 'customerId'],
        'INVALID',
        `Hatti records ad spend in ${ours}: this Google Ads account bills in ` +
          customer.value.currency,
      );
    }

    const connected = await this.db.tenant(tenant.shopId, async (tx) => {
      const saved = await saveAdAccountIn(
        tx,
        this.box,
        GOOGLE_ADS_ACCOUNTS,
        tenant.shopId,
        customerId,
        customer.value,
        grant.value,
      );
      if (!saved) return false;
      const { changed, tokenHint, before } = saved;
      const { name, currency, timezone } = customer.value;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<GoogleAdsAccountConnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.GoogleAdsAccountConnected,
        aggregateType: 'google_ads_account',
        aggregateId: tenant.shopId,
        payload: { customerId, changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'google_ads_account.connected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          customerId,
          name,
          currency,
          timezone,
          tokenHint,
          before: before && { customerId: before.account_id, tokenHint: before.token_hint },
        },
      });
      return true;
    });
    if (connected) await this.sync(tenant.shopId, at);
    return { ok: true, value: (await this.get(tenant))! };
  }

  /**
   * Disconnects the shop's Google Ads account: its grant is forgotten, and no more spend is
   * pulled; what was pulled stays. The account's ID it had, or null when none was connected. The
   * owner takes the grant back from their Google account's settings.
   */
  async disconnect(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const customerId = await deleteAdAccountIn(tx, GOOGLE_ADS_ACCOUNTS, tenant.shopId);
      if (!customerId) return null;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<GoogleAdsAccountDisconnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.GoogleAdsAccountDisconnected,
        aggregateType: 'google_ads_account',
        aggregateId: tenant.shopId,
        payload: { customerId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'google_ads_account.disconnected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { customerId },
      });
      return customerId;
    });
  }

  /**
   * Pulls the shop's spend now, as the worker would, at most once a minute: the account after
   * it, saying how it went.
   */
  async pull(
    tenant: TenantContext,
    at: Date = new Date(),
  ): Promise<MutationResult<GoogleAdsAccountRecord>> {
    const current = await this.get(tenant);
    if (!current) {
      return failOne(['base'], 'NOT_FOUND', 'Connect a Google Ads account first');
    }
    const pull = await this.sync(tenant.shopId, at, AD_SPEND_PULL_GAP_MS);
    if (!pull) {
      return failOne(
        ['base'],
        'INVALID',
        'Its spend was pulled under a minute ago: try again in a minute',
      );
    }
    return { ok: true, value: (await this.get(tenant))! };
  }

  /**
   * The shops with a Google Ads account connected whose spend was last asked for before
   * `before`, or never, those asked longest ago first: for the worker.
   */
  async dueShops(before: Date, limit = 500): Promise<string[]> {
    return adAccountsDue(this.db, GOOGLE_ADS_ACCOUNTS, before, limit);
  }

  /**
   * Pulls the shop's spend from Google at `at`, in place of what was pulled of those days before,
   * as {@link pullAdSpend} keeps it, by Meta's rules; what Google says when it refuses is kept for
   * the shop to see, and the next round tries again. Null when the shop has no account connected,
   * or its spend was asked for under `gapMs` ago.
   */
  async sync(shopId: string, at: Date = new Date(), gapMs = 0): Promise<GoogleAdsSpendPull | null> {
    return pullAdSpend(
      this.db,
      this.box,
      GOOGLE_ADS_ACCOUNTS,
      (customerId, token, since, until) => this.client.spend(customerId, token, since, until),
      shopId,
      at,
      gapMs,
    );
  }
}

function toRecord(row: AdAccountRow): GoogleAdsAccountRecord {
  const { accountId, ...kept } = adAccountKeptOf(row);
  return { customerId: accountId, ...kept };
}
