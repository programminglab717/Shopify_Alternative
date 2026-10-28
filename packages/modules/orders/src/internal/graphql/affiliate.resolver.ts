import {
  CurrentTenant,
  Money,
  PublicSite,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AffiliatesService,
  type AffiliateRecord,
  type AffiliateReport,
  type AffiliatePayoutRecord,
} from '../affiliates.service.js';
import { orderName } from '../rules.js';
import {
  Affiliate,
  AffiliateCreateInput,
  AffiliateCreatePayload,
  AffiliateOrder,
  AffiliateOrderSource,
  AffiliatePageLinkCreatePayload,
  AffiliatePayout,
  AffiliatePayoutRecordInput,
  AffiliatePayoutRecordPayload,
  AffiliateStats,
  AffiliateUpdateInput,
  AffiliateUpdatePayload,
} from './affiliate.types.js';
import { uuidOf } from './mappers.js';

/**
 * Affiliates and influencers (MKT-08, ADR-776): the shop's affiliates with what their orders
 * came to, an affiliate's orders and what the shop paid them, and affiliateCreate,
 * affiliateUpdate and affiliatePayoutRecord. Marketing's scopes, as its campaigns are.
 */
@Resolver()
export class AffiliateResolver {
  constructor(
    private readonly service: AffiliatesService,
    private readonly site: PublicSite,
  ) {}

  @Query(() => [Affiliate], {
    description:
      "The shop's affiliates, the latest added first, each with what their orders came to, " +
      'worked out from the orders when asked.',
  })
  @RequireScopes('read_marketing_events')
  async affiliates(@CurrentTenant() tenant: TenantContext): Promise<Affiliate[]> {
    const reports = await this.service.list(tenant);
    return reports.map((report) => toAffiliate(tenant, report));
  }

  @Query(() => [AffiliateOrder], {
    description:
      "An affiliate's latest 50 orders, cancelled ones aside, with what each earns them.",
  })
  @RequireScopes('read_marketing_events', 'read_orders')
  async affiliateOrders(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AffiliateOrder[]> {
    const orders = await this.service.orders(tenant, uuidOf('affiliate', id));
    const { currency } = tenant;
    return orders.map((order) =>
      Object.assign(new AffiliateOrder(), {
        orderId: toPublicId('order', order.orderId),
        name: orderName(order.number),
        placedAt: order.placedAt,
        stage: order.stage,
        source: order.by === 'code' ? AffiliateOrderSource.CODE : AffiliateOrderSource.LINK,
        base: Money.from(money(order.base, currency)),
        commission: Money.from(money(order.commission, currency)),
      }),
    );
  }

  @Query(() => [AffiliatePayout], {
    description: 'What the shop recorded paying an affiliate: the latest 50, the latest first.',
  })
  @RequireScopes('read_marketing_events')
  async affiliatePayouts(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AffiliatePayout[]> {
    const payouts = await this.service.payouts(tenant, uuidOf('affiliate', id));
    return payouts.map((payout) => toPayout(tenant, payout));
  }

  @Mutation(() => AffiliateCreatePayload, {
    description:
      'Adds an affiliate: their link is the storefront with ?ref= and their `ref`, and orders ' +
      'placed with their discount code are theirs too. Only orders placed from now count.',
  })
  @RequireScopes('write_marketing_events')
  async affiliateCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: AffiliateCreateInput,
  ): Promise<AffiliateCreatePayload> {
    const result = await this.service.create(tenant, input);
    return Object.assign(new AffiliateCreatePayload(), {
      affiliate: result.ok ? toAffiliate(tenant, withoutOrders(result.value)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AffiliatePageLinkCreatePayload, {
    description:
      "Makes a link to an affiliate's own page (ADR-899), for the shop to send them: their " +
      'link, code and share, their figures and latest orders, nothing of their customers. The ' +
      'link before it no longer works.',
  })
  @RequireScopes('write_marketing_events')
  async affiliatePageLinkCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AffiliatePageLinkCreatePayload> {
    const result = await this.service.pageLink(tenant, uuidOf('affiliate', id));
    return Object.assign(new AffiliatePageLinkCreatePayload(), {
      url: result.ok ? this.site.url(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AffiliateUpdatePayload, {
    description:
      'Changes an affiliate, or ends their part: orders placed after it earn them nothing. Their ' +
      'figures are left to `affiliates`.',
  })
  @RequireScopes('write_marketing_events')
  async affiliateUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: AffiliateUpdateInput,
  ): Promise<AffiliateUpdatePayload> {
    const { id, ...changes } = input;
    const result = await this.service.update(tenant, uuidOf('affiliate', id), changes);
    return Object.assign(new AffiliateUpdatePayload(), {
      affiliate: result.ok ? toAffiliate(tenant, withoutOrders(result.value)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AffiliatePayoutRecordPayload, {
    description:
      'Records that the shop paid an affiliate, as it did it: what is owed them goes down by it.',
  })
  @RequireScopes('write_marketing_events')
  async affiliatePayoutRecord(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: AffiliatePayoutRecordInput,
  ): Promise<AffiliatePayoutRecordPayload> {
    const result = await this.service.recordPayout(tenant, {
      ...input,
      affiliateId: uuidOf('affiliate', input.affiliateId),
    });
    return Object.assign(new AffiliatePayoutRecordPayload(), {
      payout: result.ok ? toPayout(tenant, result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** A share in hundredths of a percent, as the shop writes it: 750 is "7.5". */
export function commissionText(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** An affiliate just added or changed, whose figures are left to the list. */
function withoutOrders(record: AffiliateRecord): AffiliateReport {
  return {
    ...record,
    stats: { orders: 0, delivered: 0, sales: 0n, earned: 0n, pending: 0n, paid: 0n, owed: 0n },
  };
}

function toAffiliate(tenant: TenantContext, report: AffiliateReport): Affiliate {
  const { currency } = tenant;
  const amount = (minor: bigint) => Money.from(money(minor, currency));
  const { stats } = report;
  return Object.assign(new Affiliate(), {
    id: toPublicId('affiliate', report.id),
    name: report.name,
    phone: report.phone,
    ref: report.ref,
    discountCode: report.discountCode,
    commission: commissionText(report.commissionBps),
    active: report.endedAt === null,
    endedAt: report.endedAt,
    createdAt: report.createdAt,
    stats: Object.assign(new AffiliateStats(), {
      orders: stats.orders,
      delivered: stats.delivered,
      sales: amount(stats.sales),
      earned: amount(stats.earned),
      pending: amount(stats.pending),
      paid: amount(stats.paid),
      owed: amount(stats.owed),
    }),
  });
}

function toPayout(tenant: TenantContext, payout: AffiliatePayoutRecord): AffiliatePayout {
  return Object.assign(new AffiliatePayout(), {
    id: toPublicId('affiliatePayout', payout.id),
    amount: Money.from(money(payout.amount, tenant.currency)),
    note: payout.note,
    paidAt: payout.paidAt,
  });
}
