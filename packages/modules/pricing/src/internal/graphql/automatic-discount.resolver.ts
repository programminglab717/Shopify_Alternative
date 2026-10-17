import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  badUserInput,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AutomaticDiscountService } from '../automatic-discount.service.js';
import { automaticSummary, discountStatus } from '../discounts.js';
import type { AutomaticDiscountRecord } from '../records.js';
import {
  AutomaticDiscount,
  AutomaticDiscountDeletePayload,
  AutomaticDiscountInput,
  AutomaticDiscountPayload,
} from './automatic-discount.types.js';
import { itemIdsOf, withItemUuids } from './items.js';
import { DiscountCodeKind, DiscountStatus } from './discount-code.types.js';

/** Automatic discounts (CHK-06, ADR-515), with Shopify's discount scopes. */
@Resolver(() => AutomaticDiscount)
export class AutomaticDiscountResolver {
  constructor(private readonly service: AutomaticDiscountService) {}

  @Query(() => [AutomaticDiscount], {
    description:
      "The shop's automatic discounts, running, ahead or ended, newest first: 25 at most.",
  })
  @RequireScopes('read_discounts')
  async automaticDiscounts(@CurrentTenant() tenant: TenantContext): Promise<AutomaticDiscount[]> {
    const records = await this.service.list(tenant);
    return records.map((record) => toAutomaticDiscount(record, tenant.currency));
  }

  @Query(() => AutomaticDiscount, { nullable: true })
  @RequireScopes('read_discounts')
  async automaticDiscount(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AutomaticDiscount | null> {
    const record = await this.service.get(tenant, uuidOf(id));
    return record ? toAutomaticDiscount(record, tenant.currency) : null;
  }

  @Mutation(() => AutomaticDiscountPayload, {
    description:
      'An automatic discount, which carts and checkouts take from its start until its end.',
  })
  @RequireScopes('write_discounts')
  async automaticDiscountCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('automaticDiscount') input: AutomaticDiscountInput,
  ): Promise<AutomaticDiscountPayload> {
    const given = withItemUuids(input);
    const result = given.ok ? await this.service.create(tenant, given.value) : given;
    return payload(result, tenant.currency);
  }

  @Mutation(() => AutomaticDiscountPayload, {
    description:
      'Changes what is given of it; the rest stays. Orders placed with it keep what it took off ' +
      'them. Ending it now stops it.',
  })
  @RequireScopes('write_discounts')
  async automaticDiscountUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('automaticDiscount') input: AutomaticDiscountInput,
  ): Promise<AutomaticDiscountPayload> {
    const given = withItemUuids(input);
    const result = given.ok ? await this.service.update(tenant, uuidOf(id), given.value) : given;
    return payload(result, tenant.currency);
  }

  @Mutation(() => AutomaticDiscountDeletePayload, {
    description: 'Deletes it; orders placed with it keep its title.',
  })
  @RequireScopes('write_discounts')
  async automaticDiscountDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AutomaticDiscountDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf(id));
    return Object.assign(new AutomaticDiscountDeletePayload(), {
      deletedAutomaticDiscountId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function payload(
  result: { ok: true; value: AutomaticDiscountRecord } | { ok: false; errors: FieldError[] },
  currency: CurrencyCode,
): AutomaticDiscountPayload {
  return Object.assign(new AutomaticDiscountPayload(), {
    automaticDiscount: result.ok ? toAutomaticDiscount(result.value, currency) : null,
    userErrors: result.ok ? [] : UserError.list(inInput(result.errors)),
  });
}

/** The UUID behind an automatic discount's public ID, or a BAD_USER_INPUT error. */
function uuidOf(id: string): string {
  const uuid = tryFromPublicId(id, 'automaticDiscount');
  if (!uuid) throw badUserInput(`Invalid automaticDiscount id: ${id.slice(0, 64)}`);
  return uuid;
}

/** Errors on the input's fields, under the argument they came in. */
function inInput(errors: FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length > 0 ? { ...error, field: ['automaticDiscount', ...error.field] } : error,
  );
}

const KINDS = {
  percentage: DiscountCodeKind.PERCENTAGE,
  fixed_amount: DiscountCodeKind.FIXED_AMOUNT,
  free_shipping: DiscountCodeKind.FREE_SHIPPING,
  buy_x_get_y: DiscountCodeKind.BUY_X_GET_Y,
} as const;

const STATUSES = {
  scheduled: DiscountStatus.SCHEDULED,
  active: DiscountStatus.ACTIVE,
  expired: DiscountStatus.EXPIRED,
} as const;

export function toAutomaticDiscount(
  record: AutomaticDiscountRecord,
  currency: CurrencyCode,
): AutomaticDiscount {
  const amount = (value: bigint | null) =>
    value === null ? null : Money.from(money(value, currency));
  return Object.assign(new AutomaticDiscount(), {
    id: toPublicId('automaticDiscount', record.id),
    title: record.title,
    kind: KINDS[record.kind],
    percentage: record.percentageBps === null ? null : record.percentageBps / 100,
    amount: amount(record.amount),
    minimumSubtotal: amount(record.minimumSubtotal),
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    status: STATUSES[discountStatus(record)],
    combinesWithCodes: record.combinesWithCodes,
    buyQuantity: record.buyQuantity,
    getQuantity: record.getQuantity,
    ...itemIdsOf(record),
    summary: automaticSummary(record, currency),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
