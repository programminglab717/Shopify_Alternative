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
  type TikTokAdAccountConnectedPayload,
  type TikTokAdAccountDisconnectedPayload,
} from './events.js';
import { TikTokAdsClient, advertiserIdOf } from './tiktok-ad-spend.js';
import { TIKTOK_LIMITS } from './tiktok-settings.service.js';

/** Where shops' TikTok advertiser accounts are kept, and their spend pulled to. */
const TIKTOK_AD_ACCOUNTS: AdAccountTable = {
  platform: 'tiktok',
  source: 'tiktok_api',
  table: 'tiktok_ad_accounts',
  idColumn: 'advertiser_id',
  idField: 'advertiserId',
  sealing: 'tiktok-ads',
};

/** The shop's TikTok advertiser account, as the Admin API shows it: never its token. */
export interface TikTokAdAccountRecord {
  /** Its digits, as TikTok Ads Manager shows them. */
  advertiserId: string;
  name: string;
  currency: string;
  /** The time zone TikTok reports its days in; null when TikTok gave none. */
  timezone: string | null;
  /** The token's last four characters. */
  tokenHint: string;
  /** When its spend was last pulled; null before the first time. */
  lastSyncedAt: Date | null;
  /** Why the last pull failed; null when it went through. */
  lastError: string | null;
  updatedAt: Date;
}

export interface TikTokAdAccountInput {
  /** Its digits, as TikTok Ads Manager shows them. */
  advertiserId: string;
  /** A long-term access token of the advertiser, from TikTok's Marketing API. */
  accessToken: string;
}

/** How pulling the shop's spend went: how many days it covered and entries it kept, or why not. */
export type TikTokAdSpendPull = AdSpendPull;

/**
 * The shop's TikTok advertiser account (MKT-12, ADR-566), whose spend is pulled from TikTok's
 * Business API each day by campaign, as a Meta ad account's is from Meta (ADR-564): its ID, a
 * long-term token of it from TikTok's Marketing API, kept sealed and never shown again, and how
 * the last pull went. TikTok is asked before anything is kept, and the account must bill in the
 * shop's currency, as its spend is kept in it. Connecting is audited, the token never; a plan
 * without true profit connects none, keeping one connected before (ADR-523, ADR-529).
 *
 * Each pull covers the last week, the shop's today among them, as TikTok revises its recent days;
 * the first, the last 30. TikTok reports days in the advertiser's time zone, and each is kept as
 * the shop's day of that date, as Meta's are: a Pakistani shop's advertiser is in Pakistan's
 * time, as its shop is, and one in another zone is not moved into the shop's (its zone is kept,
 * for the admin to show).
 */
@Injectable()
export class TikTokAdAccountService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly client: TikTokAdsClient,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<TikTokAdAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) =>
      adAccountIn(tx, TIKTOK_AD_ACCOUNTS, tenant.shopId),
    );
    return row && toRecord(row);
  }

  /**
   * Connects the shop's advertiser account, in place of any it had, or gives it another token,
   * once TikTok says the token reads it; then pulls its spend, the last 30 days the first time. A
   * pull that fails leaves the account connected, saying why.
   */
  async connect(
    tenant: TenantContext,
    input: TikTokAdAccountInput,
    at: Date = new Date(),
  ): Promise<MutationResult<TikTokAdAccountRecord>> {
    const check = new InputChecker();
    const advertiserId = advertiserIdOf(input.advertiserId);
    if (!advertiserId) {
      check.add(
        ['input', 'advertiserId'],
        'INVALID',
        "must be the advertiser account's ID, as TikTok Ads Manager shows it: 5 to 25 digits",
      );
    }
    const accessToken = input.accessToken.trim();
    if (
      accessToken.length < 20 ||
      accessToken.length > TIKTOK_LIMITS.accessToken ||
      !/^[!-~]+$/.test(accessToken)
    ) {
      check.add(
        ['input', 'accessToken'],
        'INVALID',
        "must be a long-term access token of the advertiser, as TikTok's Marketing API gave it",
      );
    }
    if (!check.ok || !advertiserId) return { ok: false, errors: check.errors };
    const existing = await this.get(tenant);
    const plan = existing ? null : await this.allowance?.excludes(tenant.shopId, 'trueProfit');
    if (plan) {
      return failOne(
        ['input'],
        'INVALID',
        planFeatureMessage(plan, 'true profit', "connect TikTok's ad spend"),
      );
    }

    const advertiser = await this.client.advertiser(advertiserId, accessToken);
    if (!advertiser.ok) {
      return failOne(
        advertiser.kind === 'account' ? ['input', 'advertiserId'] : ['input', 'accessToken'],
        advertiser.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID',
        advertiser.message,
      );
    }
    if (advertiser.value.currency !== tenant.currency) {
      const ours = tenant.currency === 'PKR' ? 'rupees' : tenant.currency;
      return failOne(
        ['input', 'advertiserId'],
        'INVALID',
        `Hatti records ad spend in ${ours}: this advertiser account bills in ` +
          advertiser.value.currency,
      );
    }

    const connected = await this.db.tenant(tenant.shopId, async (tx) => {
      const saved = await saveAdAccountIn(
        tx,
        this.box,
        TIKTOK_AD_ACCOUNTS,
        tenant.shopId,
        advertiserId,
        advertiser.value,
        accessToken,
      );
      if (!saved) return false;
      const { changed, tokenHint, before } = saved;
      const { name, currency, timezone } = advertiser.value;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<TikTokAdAccountConnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.TikTokAdAccountConnected,
        aggregateType: 'tiktok_ad_account',
        aggregateId: tenant.shopId,
        payload: { advertiserId, changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'tiktok_ad_account.connected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          advertiserId,
          name,
          currency,
          timezone,
          tokenHint,
          before: before && { advertiserId: before.account_id, tokenHint: before.token_hint },
        },
      });
      return true;
    });
    if (connected) await this.sync(tenant.shopId, at);
    return { ok: true, value: (await this.get(tenant))! };
  }

  /**
   * Disconnects the shop's advertiser account: its token is forgotten, and no more spend is
   * pulled; what was pulled stays. The advertiser's ID it had, or null when none was connected.
   */
  async disconnect(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const advertiserId = await deleteAdAccountIn(tx, TIKTOK_AD_ACCOUNTS, tenant.shopId);
      if (!advertiserId) return null;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<TikTokAdAccountDisconnectedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.TikTokAdAccountDisconnected,
        aggregateType: 'tiktok_ad_account',
        aggregateId: tenant.shopId,
        payload: { advertiserId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'tiktok_ad_account.disconnected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { advertiserId },
      });
      return advertiserId;
    });
  }

  /**
   * Pulls the shop's spend now, as the worker would, at most once a minute: the account after
   * it, saying how it went.
   */
  async pull(
    tenant: TenantContext,
    at: Date = new Date(),
  ): Promise<MutationResult<TikTokAdAccountRecord>> {
    const current = await this.get(tenant);
    if (!current) {
      return failOne(['base'], 'NOT_FOUND', 'Connect a TikTok advertiser account first');
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
   * The shops with an advertiser connected whose spend was last asked for before `before`, or
   * never, those asked longest ago first: for the worker.
   */
  async dueShops(before: Date, limit = 500): Promise<string[]> {
    return adAccountsDue(this.db, TIKTOK_AD_ACCOUNTS, before, limit);
  }

  /**
   * Pulls the shop's spend from TikTok at `at`, in place of what was pulled of those days before,
   * as {@link pullAdSpend} keeps it, by Meta's rules; what TikTok says when it refuses is kept for
   * the shop to see, and the next round tries again. Null when the shop has no advertiser
   * connected, or its spend was asked for under `gapMs` ago.
   */
  async sync(shopId: string, at: Date = new Date(), gapMs = 0): Promise<TikTokAdSpendPull | null> {
    return pullAdSpend(
      this.db,
      this.box,
      TIKTOK_AD_ACCOUNTS,
      (advertiserId, token, since, until) => this.client.spend(advertiserId, token, since, until),
      shopId,
      at,
      gapMs,
    );
  }
}

function toRecord(row: AdAccountRow): TikTokAdAccountRecord {
  const { accountId, ...kept } = adAccountKeptOf(row);
  return { advertiserId: accountId, ...kept };
}
