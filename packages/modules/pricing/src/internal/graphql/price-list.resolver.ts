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
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  PriceListService,
  type PriceListPrice as PriceListPriceRecord,
  type PriceListRecord,
} from '../price-lists.js';
import {
  PriceList,
  PriceListDeletePayload,
  PriceListInput,
  PriceListPayload,
  PriceListPrice,
  PriceListPriceInput,
  PriceListPricesSetPayload,
  PriceListQuantityBreak,
} from './price-list.types.js';

/** Hundredths of a percent as the shop writes a share: 750 is "7.5". */
function percentText(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
}

function uuidOf(kind: 'priceList' | 'variant', id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

function toPriceList(record: PriceListRecord): PriceList {
  return Object.assign(new PriceList(), {
    id: toPublicId('priceList', record.id),
    name: record.name,
    customerTag: record.customerTag,
    percentOff: percentText(record.percentOffBps),
    quantityBreaks: record.quantityBreaks.map((each) =>
      Object.assign(new PriceListQuantityBreak(), {
        minQuantity: each.minQuantity,
        percentOff: percentText(each.percentOffBps),
      }),
    ),
    pricedVariants: record.pricedVariants,
    updatedAt: record.updatedAt,
  });
}

/**
 * Wholesale price lists (CUS-06, ADR-778): priceLists and a list's prices, and priceListCreate,
 * priceListUpdate, priceListDelete and priceListPricesSet, with the products' scopes, as
 * Shopify's price lists are.
 */
@Resolver(() => PriceList)
export class PriceListResolver {
  constructor(private readonly service: PriceListService) {}

  @Query(() => [PriceList], { description: "The shop's price lists, in the order they were made." })
  @RequireScopes('read_products')
  async priceLists(@CurrentTenant() tenant: TenantContext): Promise<PriceList[]> {
    return (await this.service.list(tenant)).map(toPriceList);
  }

  @Query(() => [PriceListPrice], {
    nullable: true,
    description: 'The variants with a price of their own in a price list; null for no such list.',
  })
  @RequireScopes('read_products')
  async priceListPrices(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PriceListPrice[] | null> {
    const prices = await this.service.prices(tenant, uuidOf('priceList', id));
    return prices ? prices.map((each) => toPrice(tenant, each)) : null;
  }

  @Mutation(() => PriceListPayload, {
    description: 'Makes a price list for the customers with a tag: a shop keeps up to 20.',
  })
  @RequireScopes('write_products')
  async priceListCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PriceListInput,
  ): Promise<PriceListPayload> {
    const result = await this.service.create(tenant, {
      name: input.name ?? '',
      customerTag: input.customerTag ?? '',
      percentOff: input.percentOff,
      quantityBreaks: input.quantityBreaks,
    });
    return Object.assign(new PriceListPayload(), {
      priceList: result.ok ? toPriceList(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PriceListPayload, { description: 'Changes a price list; fields left out stay.' })
  @RequireScopes('write_products')
  async priceListUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PriceListInput,
  ): Promise<PriceListPayload> {
    const result = await this.service.update(tenant, uuidOf('priceList', id), input);
    return Object.assign(new PriceListPayload(), {
      priceList: result.ok ? toPriceList(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PriceListDeletePayload, {
    description: 'Deletes a price list; its customers pay what anyone pays again.',
  })
  @RequireScopes('write_products')
  async priceListDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PriceListDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('priceList', id));
    return Object.assign(new PriceListDeletePayload(), {
      deletedPriceListId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PriceListPricesSetPayload, {
    description:
      'Gives variants a price of their own in a price list, in place of its share off, or takes ' +
      "it away; the others' stay. Up to 2,000 variants in a list.",
  })
  @RequireScopes('write_products')
  async priceListPricesSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('prices', { type: () => [PriceListPriceInput] }) prices: PriceListPriceInput[],
  ): Promise<PriceListPricesSetPayload> {
    const result = await this.service.setPrices(
      tenant,
      uuidOf('priceList', id),
      prices.map((each) => ({
        variantId: uuidOf('variant', each.variantId),
        price: each.price ?? null,
      })),
    );
    return Object.assign(new PriceListPricesSetPayload(), {
      prices: result.ok ? result.value.map((each) => toPrice(tenant, each)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toPrice(tenant: TenantContext, each: PriceListPriceRecord): PriceListPrice {
  return Object.assign(new PriceListPrice(), {
    variantId: toPublicId('variant', each.variantId),
    price: Money.from(money(each.price, tenant.currency)),
    productTitle: each.productTitle,
    variantTitle: each.variantTitle,
    retailPrice: Money.from(money(each.retailPrice, tenant.currency)),
  });
}
