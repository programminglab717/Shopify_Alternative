import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  SpinWheelService,
  type SpinSliceKind as SliceKind,
  type SpinWheelRecord,
} from '../spin-wheel.js';
import { SpinSliceKind, SpinWheel, SpinWheelInput, SpinWheelPayload } from './spin-wheel.types.js';

const KINDS: Record<SliceKind, SpinSliceKind> = {
  percentage: SpinSliceKind.PERCENTAGE,
  amount: SpinSliceKind.FIXED_AMOUNT,
  free_shipping: SpinSliceKind.FREE_SHIPPING,
  none: SpinSliceKind.NONE,
};

const KINDS_GIVEN: Record<SpinSliceKind, SliceKind> = {
  [SpinSliceKind.PERCENTAGE]: 'percentage',
  [SpinSliceKind.FIXED_AMOUNT]: 'amount',
  [SpinSliceKind.FREE_SHIPPING]: 'free_shipping',
  [SpinSliceKind.NONE]: 'none',
};

/** The shop's spin-to-win wheel (OS-08, ADR-900). */
@Resolver(() => SpinWheel)
export class SpinWheelResolver {
  constructor(private readonly service: SpinWheelService) {}

  @Query(() => SpinWheel, { description: "The shop's spin-to-win wheel, off until set." })
  @RequireScopes('read_discounts')
  async spinWheel(@CurrentTenant() tenant: TenantContext): Promise<SpinWheel> {
    return toSpinWheel(await this.service.get(tenant), tenant.currency);
  }

  @Mutation(() => SpinWheelPayload, {
    description:
      'Changes the wheel; the rest stays. Codes it gave keep what they give. Turned on, it needs ' +
      '2 to 8 slices.',
  })
  @RequireScopes('write_discounts')
  async spinWheelUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('spinWheel') input: SpinWheelInput,
  ): Promise<SpinWheelPayload> {
    const result = await this.service.update(tenant, {
      ...input,
      slices: input.slices?.map((slice) => ({ ...slice, kind: KINDS_GIVEN[slice.kind] })),
    });
    return Object.assign(new SpinWheelPayload(), {
      spinWheel: result.ok ? toSpinWheel(result.value, tenant.currency) : null,
      userErrors: result.ok
        ? []
        : UserError.list(
            result.errors.map((error) => ({ ...error, field: ['spinWheel', ...error.field] })),
          ),
    });
  }
}

function toSpinWheel(record: SpinWheelRecord, currency: CurrencyCode): SpinWheel {
  const amount = (value: bigint | null) =>
    value === null ? null : Money.from(money(value, currency));
  return Object.assign(new SpinWheel(), {
    enabled: record.enabled,
    slices: record.slices.map((slice) => ({
      label: slice.label,
      kind: KINDS[slice.kind],
      percentage: slice.percentage,
      amount: amount(slice.amount),
      weight: slice.weight,
    })),
    codeDays: record.codeDays,
    minimumSubtotal: amount(record.minimumSubtotal),
    spins: record.spins,
    codesUsed: record.codesUsed,
    updatedAt: record.updatedAt,
  });
}
