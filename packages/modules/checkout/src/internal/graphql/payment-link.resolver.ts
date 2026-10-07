import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaymentLinkService } from '../payment-link.service.js';
import type {
  PaymentLinkInput as PaymentLinkInputValue,
  PaymentLinkRecord,
} from '../payment-links.js';
import { PaymentLink, PaymentLinkInput, PaymentLinkPayload } from './payment-link.types.js';

@Resolver()
export class PaymentLinkResolver {
  constructor(private readonly service: PaymentLinkService) {}

  @Query(() => [PaymentLink], {
    description:
      "The shop's payment links, newest first: `first` of them (50 unless given), after the link `after` names.",
  })
  @RequireScopes('read_orders')
  async paymentLinks(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true }) first: number | null,
    @Args('after', { type: () => ID, nullable: true }) after: string | null,
  ): Promise<PaymentLink[]> {
    return (
      await this.service.list(tenant, {
        first: first ?? undefined,
        after: after && uuidOf('paymentLink', after),
      })
    ).map(toLink);
  }

  @Query(() => PaymentLink, { nullable: true })
  @RequireScopes('read_orders')
  async paymentLink(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PaymentLink | null> {
    const link = await this.service.get(tenant, uuidOf('paymentLink', id));
    return link && toLink(link);
  }

  @Mutation(() => PaymentLinkPayload, {
    description:
      'A new payment link (PAY-04), open at once at its own address, for the shop to share: ' +
      'its items, a title for staff, and the rest as given.',
  })
  @RequireScopes('write_orders')
  async paymentLinkCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PaymentLinkInput,
  ): Promise<PaymentLinkPayload> {
    return payload(await this.service.create(tenant, inputOf(input)));
  }

  @Mutation(() => PaymentLinkPayload, {
    description:
      'Changes a payment link, its address and orders as they are; `active: false` closes it, ' +
      'and the checkouts it opened with it.',
  })
  @RequireScopes('write_orders')
  async paymentLinkUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PaymentLinkInput,
  ): Promise<PaymentLinkPayload> {
    return payload(await this.service.update(tenant, uuidOf('paymentLink', id), inputOf(input)));
  }
}

function payload(
  result:
    | { ok: true; value: PaymentLinkRecord }
    | { ok: false; errors: Parameters<typeof UserError.list>[0] },
): PaymentLinkPayload {
  return Object.assign(new PaymentLinkPayload(), {
    paymentLink: result.ok ? toLink(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

function toLink(record: PaymentLinkRecord): PaymentLink {
  return Object.assign(new PaymentLink(), {
    ...record,
    id: toPublicId('paymentLink', record.id),
    items: record.items.map((item) => ({
      ...item,
      variantId: toPublicId('variant', item.variantId),
    })),
  });
}

/** The input with its variants' UUIDs; a variant ID that is none is a BAD_USER_INPUT error. */
function inputOf(input: PaymentLinkInput): PaymentLinkInputValue {
  return {
    ...input,
    items: input.items?.map((item) => ({
      variantId: uuidOf('variant', item.variantId),
      quantity: item.quantity,
    })),
  };
}

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}
