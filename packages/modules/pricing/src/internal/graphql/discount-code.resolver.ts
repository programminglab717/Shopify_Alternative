import {
  CurrentTenant,
  Money,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiscountCodeService } from '../discount-code.service.js';
import { discountStatus, discountSummary } from '../discounts.js';
import type { DiscountCodeRecord } from '../records.js';
import {
  DiscountCode,
  DiscountCodeConnection,
  DiscountCodeCreatePayload,
  DiscountCodeDeletePayload,
  DiscountCodeEdge,
  DiscountCodeInput,
  DiscountCodeKind,
  DiscountCodeUpdatePayload,
  DiscountCodesArgs,
  DiscountStatus,
} from './discount-code.types.js';

/** Discount codes (CHK-06, ADR-062), with Shopify's discount scopes. */
@Resolver(() => DiscountCode)
export class DiscountCodeResolver {
  constructor(private readonly service: DiscountCodeService) {}

  @Query(() => DiscountCodeConnection, { description: "The shop's discount codes, newest first." })
  @RequireScopes('read_discounts')
  async discountCodes(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: DiscountCodesArgs,
  ): Promise<DiscountCodeConnection> {
    const after = args.after ? uuidOf(decodeCursor(args.after, ['id']).id) : null;
    const first = pageSize(args.first);
    const { items, hasNextPage } = await this.service.list(tenant, {
      first,
      after,
      query: args.query,
    });
    const nodes = items.map((record) => toDiscountCode(record, tenant.currency));
    const edges = nodes.map((node) =>
      Object.assign(new DiscountCodeEdge(), { cursor: encodeCursor({ id: node.id }), node }),
    );
    return Object.assign(new DiscountCodeConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => DiscountCode, { nullable: true })
  @RequireScopes('read_discounts')
  async discountCode(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DiscountCode | null> {
    const record = await this.service.get(tenant, uuidOf(id));
    return record ? toDiscountCode(record, tenant.currency) : null;
  }

  @Query(() => DiscountCode, {
    nullable: true,
    description: 'The code shoppers type, in any letter case.',
  })
  @RequireScopes('read_discounts')
  async discountCodeByCode(
    @CurrentTenant() tenant: TenantContext,
    @Args('code') code: string,
  ): Promise<DiscountCode | null> {
    const record = await this.service.byCode(tenant, code);
    return record ? toDiscountCode(record, tenant.currency) : null;
  }

  @Mutation(() => DiscountCodeCreatePayload, {
    description: 'A discount code, which works from its start until its end or its last use.',
  })
  @RequireScopes('write_discounts')
  async discountCodeCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('discountCode') discountCode: DiscountCodeInput,
  ): Promise<DiscountCodeCreatePayload> {
    const result = await this.service.create(tenant, discountCode);
    return Object.assign(new DiscountCodeCreatePayload(), {
      discountCode: result.ok ? toDiscountCode(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(inDiscountCode(result.errors)),
    });
  }

  @Mutation(() => DiscountCodeUpdatePayload, {
    description:
      'Changes what is given of the code; the rest stays. Orders placed with it keep what it ' +
      'took off them. Ending it now stops it.',
  })
  @RequireScopes('write_discounts')
  async discountCodeUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('discountCode') discountCode: DiscountCodeInput,
  ): Promise<DiscountCodeUpdatePayload> {
    const result = await this.service.update(tenant, uuidOf(id), discountCode);
    return Object.assign(new DiscountCodeUpdatePayload(), {
      discountCode: result.ok ? toDiscountCode(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(inDiscountCode(result.errors)),
    });
  }

  @Mutation(() => DiscountCodeDeletePayload, {
    description: 'Deletes the code; orders placed with it keep it.',
  })
  @RequireScopes('write_discounts')
  async discountCodeDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DiscountCodeDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf(id));
    return Object.assign(new DiscountCodeDeletePayload(), {
      deletedDiscountCodeId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** The UUID behind a discount code's public ID, or a BAD_USER_INPUT error. */
function uuidOf(id: string): string {
  const uuid = tryFromPublicId(id, 'discountCode');
  if (!uuid) throw badUserInput(`Invalid discountCode id: ${id.slice(0, 64)}`);
  return uuid;
}

/** Errors on the input's fields, under the argument they came in. */
function inDiscountCode(errors: FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length > 0 ? { ...error, field: ['discountCode', ...error.field] } : error,
  );
}

const KINDS = {
  percentage: DiscountCodeKind.PERCENTAGE,
  fixed_amount: DiscountCodeKind.FIXED_AMOUNT,
  free_shipping: DiscountCodeKind.FREE_SHIPPING,
} as const;

const STATUSES = {
  scheduled: DiscountStatus.SCHEDULED,
  active: DiscountStatus.ACTIVE,
  expired: DiscountStatus.EXPIRED,
} as const;

export function toDiscountCode(record: DiscountCodeRecord, currency: CurrencyCode): DiscountCode {
  const amount = (value: bigint | null) =>
    value === null ? null : Money.from(money(value, currency));
  return Object.assign(new DiscountCode(), {
    id: toPublicId('discountCode', record.id),
    code: record.code,
    title: record.title,
    kind: KINDS[record.kind],
    percentage: record.percentageBps === null ? null : record.percentageBps / 100,
    amount: amount(record.amount),
    minimumSubtotal: amount(record.minimumSubtotal),
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    status: STATUSES[discountStatus(record)],
    usageLimit: record.usageLimit,
    oncePerCustomer: record.oncePerCustomer,
    usageCount: record.used,
    summary: discountSummary(record, currency),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
