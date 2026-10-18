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
  AD_SPEND_PULL_DAYS,
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
  type MetaAdAccountConnectedPayload,
  type MetaAdAccountDisconnectedPayload,
} from './events.js';
import { MetaAdsClient, adAccountIdOf } from './meta-ad-spend.js';
import { META_LIMITS } from './meta-settings.service.js';

/**
 * The days each pull covers, today in the shop's time zone among them: the last week, which Meta
 * still revises; the last 30 the first time.
 */
export const META_AD_SPEND_DAYS = AD_SPEND_PULL_DAYS;

/** How soon after the last the shop may have its spend pulled again. */
export const META_AD_SPEND_PULL_GAP_MS = AD_SPEND_PULL_GAP_MS;

/** Where shops' Meta ad accounts are kept, and their spend pulled to. */
const META_AD_ACCOUNTS: AdAccountTable = {
  platform: 'meta',
  source: 'meta_api',
  table: 'meta_ad_accounts',
  idColumn: 'ad_account_id',
  idField: 'adAccountId',
  sealing: 'meta-ads',
};

/** The shop's Meta ad account, as the Admin API shows it: never its token. */
export interface MetaAdAccountRecord {
  /** Its digits, without "act_". */
  adAccountId: string;
  name: string;
  currency: string;
  /** The time zone Meta reports its days in; null when Meta gave none. */
  timezone: string | null;
  /** The token's last four characters. */
  tokenHint: string;
  /** When its spend was last pulled; null before the first time. */
  lastSyncedAt: Date | null;
  /** Why the last pull failed; null when it went through. */
  lastError: string | null;
  updatedAt: Date;
}

export interface MetaAdAccountInput {
  /** "act_123456789", or its digits. */
  adAccountId: string;
  /** A token with ads_read on the account: a system user's, typically. */
  accessToken: string;
}

/** How pulling the shop's spend went: how many days it covered and entries it kept, or why not. */
export type MetaAdSpendPull = AdSpendPull;

/**
 * The shop's Meta ad account (MKT-12, ADR-564), whose spend is pulled from Meta's Marketing API
 * each day by campaign, in place of the shop typing it (ADR-553): its ID, a token with ads_read
 * on it, kept sealed and never shown again, and how the last pull went. Meta is asked before
 * anything is kept, and the account must bill in the shop's currency, as its spend is kept in
 * it. Connecting is audited, the token never; a plan without true profit connects none, keeping
 * one connected before (ADR-523, ADR-529).
 *
 * Each pull covers the last week, the shop's today among them, as Meta revises its recent days;
 * the first, the last 30. Meta reports days in the ad account's time zone, and each is kept as
 * the shop's day of that date: a Pakistani shop's account is in Pakistan's time, as its shop is,
 * and one in another zone is not moved into the shop's (its zone is kept, for the admin to show).
 */
@Injectable()
export class MetaAdAccountService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly client: MetaAdsClient,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<MetaAdAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) =>
      adAccountIn(tx, META_AD_ACCOUNTS, tenant.shopId),
    );
    return row && toRecord(row);
  }

  /**
   * Connects the shop's ad account, in place of any it had, or gives it another token, once Meta
   * says the token reads it; then pulls its spend, the last 30 days the first time. A pull that
   * fails leaves the account connected, saying why.
   */
  async connect(
    tenant: TenantContext,
    input: MetaAdAccountInput,
    at: Date = new Date(),
  ): Promise<MutationResult<MetaAdAccountRecord>> {
    const check = new InputChecker();
    const adAccountId = adAccountIdOf(input.adAccountId);
    if (!adAccountId) {
      check.add(
        ['input', 'adAccountId'],
        'INVALID',
        "must be the ad account's ID, as Ads Manager shows it: act_ and 5 to 20 digits",
      );
    }
    const accessToken = input.accessToken.trim();
    if (
      accessToken.length < 20 ||
      accessToken.length > META_LIMITS.accessToken ||
      !/^[!-~]+$/.test(accessToken)
    ) {
      check.add(
        ['input', 'accessToken'],
        'INVALID',
        'must be an access token that reads the ad account, as Meta gave it',
      );
    }
    if (!check.ok || !adAccountId) return { ok: false, errors: check.errors };
    const existing = await this.get(tenant);
    const plan = existing ? null : await this.allowance?.excludes(tenant.shopId, 'trueProfit');
    if (plan) {
      return failOne(
        ['input'],
        'INVALID',
        planFeatureMessage(plan, 'true profit', "connect Meta's ad spend"),
      );
    }

    const account = await this.client.account(adAccountId, accessToken);
    if (!account.ok) {
      return failOne(
        account.kind === 'account' ? ['input', 'adAccountId'] : ['input', 'accessToken'],
        account.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID',
        account.message,
      );
    }
    if (account.value.currency !== tenant.currency) {
      const ours = tenant.currency === 'PKR' ? 'rupees' : tenant.currency;
      return failOne(
        ['input', 'adAccountId'],
        'INVALID',
        `Hatti records ad spend in ${ours}: this ad account bills in ${account.value.currency}`,
      );
    }

    const connected = await this.db.tenant(tenant.shopId, async (tx) => {
      const saved = await saveAdAccountIn(
        tx,
        this.box,
        META_AD_ACCOUNTS,
        tenant.shopId,
        adAccountId,
        account.value,
        accessToken,
      );
      if (!saved) return false;
      const { changed, tokenHint: hint, before: current } = saved;
      const { name, currency, timezone } = account.value;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MetaAdAccountConnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.MetaAdAccountConnected,
        aggregateType: 'meta_ad_account',
        aggregateId: tenant.shopId,
        payload: { adAccountId, changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'meta_ad_account.connected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          adAccountId,
          name,
          currency,
          timezone,
          tokenHint: hint,
          before: current && { adAccountId: current.account_id, tokenHint: current.token_hint },
        },
      });
      return true;
    });
    if (connected) await this.sync(tenant.shopId, at);
    return { ok: true, value: (await this.get(tenant))! };
  }

  /**
   * Disconnects the shop's ad account: its token is forgotten, and no more spend is pulled; what
   * was pulled stays. The account's ID it had, or null when none was connected.
   */
  async disconnect(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const adAccountId = await deleteAdAccountIn(tx, META_AD_ACCOUNTS, tenant.shopId);
      if (!adAccountId) return null;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MetaAdAccountDisconnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.MetaAdAccountDisconnected,
        aggregateType: 'meta_ad_account',
        aggregateId: tenant.shopId,
        payload: { adAccountId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'meta_ad_account.disconnected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { adAccountId },
      });
      return adAccountId;
    });
  }

  /**
   * Pulls the shop's spend now, as the worker would, at most once a minute: the account after
   * it, saying how it went.
   */
  async pull(
    tenant: TenantContext,
    at: Date = new Date(),
  ): Promise<MutationResult<MetaAdAccountRecord>> {
    const current = await this.get(tenant);
    if (!current) {
      return failOne(['base'], 'NOT_FOUND', 'Connect a Meta ad account first');
    }
    const pull = await this.sync(tenant.shopId, at, META_AD_SPEND_PULL_GAP_MS);
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
   * The shops with an ad account connected whose spend was last asked for before `before`, or
   * never, those asked longest ago first: for the worker.
   */
  async dueShops(before: Date, limit = 500): Promise<string[]> {
    return adAccountsDue(this.db, META_AD_ACCOUNTS, before, limit);
  }

  /**
   * Pulls the shop's spend from Meta at `at`, in place of what was pulled of those days before,
   * as {@link pullAdSpend} keeps it; what Meta says when it refuses is kept for the shop to see,
   * and the next round tries again. Null when the shop has no account connected, or its spend was
   * asked for under `gapMs` ago. A token or account changed meanwhile is the next pull's.
   */
  async sync(shopId: string, at: Date = new Date(), gapMs = 0): Promise<MetaAdSpendPull | null> {
    return pullAdSpend(
      this.db,
      this.box,
      META_AD_ACCOUNTS,
      (adAccountId, token, since, until) => this.client.spend(adAccountId, token, since, until),
      shopId,
      at,
      gapMs,
    );
  }
}

function toRecord(row: AdAccountRow): MetaAdAccountRecord {
  const { accountId, ...kept } = adAccountKeptOf(row);
  return { adAccountId: accountId, ...kept };
}
