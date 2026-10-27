import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  REFERRALS,
  ReferralProgramService,
  type ReferralProgramRecord,
} from '../referrals.service.js';
import {
  Referral,
  ReferralOutcome,
  ReferralProgram,
  ReferralProgramInput,
  ReferralProgramUpdatePayload,
  ReferralRefusal,
} from './referral.types.js';

@Resolver()
export class ReferralResolver {
  constructor(private readonly service: ReferralProgramService) {}

  @Query(() => ReferralProgram, {
    description: "The shop's referral programme (MKT-07), as set, or off where it never was.",
  })
  @RequireScopes('read_marketing_events')
  async referralProgram(@CurrentTenant() tenant: TenantContext): Promise<ReferralProgram> {
    return toProgram(await this.service.get(tenant), tenant);
  }

  @Mutation(() => ReferralProgramUpdatePayload, {
    description: "Turns the shop's referral programme on or off, or changes its credit.",
  })
  @RequireScopes('write_marketing_events')
  async referralProgramUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ReferralProgramInput,
  ): Promise<ReferralProgramUpdatePayload> {
    const result = await this.service.update(tenant, input);
    return Object.assign(new ReferralProgramUpdatePayload(), {
      referralProgram: result.ok ? toProgram(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [Referral], { description: "The referrals the shop's codes brought, latest first." })
  @RequireScopes('read_marketing_events')
  async referrals(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 50 }) first: number,
  ): Promise<Referral[]> {
    const money_ = (amount: bigint) => Money.from(money(amount, tenant.currency));
    return (await this.service.referrals(tenant, first)).map((record) =>
      Object.assign(new Referral(), {
        orderId: toPublicId('order', record.orderId),
        referrerId: toPublicId('customer', record.referrerId),
        friendId: toPublicId('customer', record.friendId),
        outcome: record.outcome.toUpperCase() as ReferralOutcome,
        reason: record.reason && (record.reason.toUpperCase() as ReferralRefusal),
        referrerCredit: money_(record.referrerCredit),
        friendCredit: money_(record.friendCredit),
        createdAt: record.createdAt,
      }),
    );
  }

  @Query(() => String, {
    nullable: true,
    description:
      "A customer's referral code, made the first time it is asked for: the online store's " +
      'link with `?invite=` and it brings their friends. Null for no such customer.',
  })
  @RequireScopes('read_customers')
  async customerReferralCode(
    @CurrentTenant() tenant: TenantContext,
    @Args('customerId', { type: () => ID }) customerId: string,
  ): Promise<string | null> {
    const id = tryFromPublicId(customerId, 'customer');
    if (!id) throw badUserInput(`Invalid customer id: ${customerId.slice(0, 64)}`);
    return this.service.codeOf(tenant.shopId, id);
  }
}

function toProgram(record: ReferralProgramRecord, tenant: TenantContext): ReferralProgram {
  const money_ = (amount: bigint) => Money.from(money(amount, tenant.currency));
  return Object.assign(new ReferralProgram(), {
    enabled: record.enabled,
    referrerCredit: money_(record.referrerCredit),
    friendCredit: money_(record.friendCredit),
    creditDays: record.creditDays,
    minimumOrder: money_(record.minimumOrder),
    perMonth: REFERRALS.perMonth,
    updatedAt: record.updatedAt,
  });
}
