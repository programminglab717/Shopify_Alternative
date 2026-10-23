import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { DiscountCodeService, type DiscountCodeInput } from '@hatti/pricing/public';
import {
  readStoreDiscounts,
  type StoreDiscount,
  type StoreDiscountItems,
} from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

@ObjectType({ description: "A store's discount that did not come, or not whole, and why." })
export class StoreDiscountImportError {
  @Field({ description: "The discount's title at the store." })
  discount!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class DiscountsImportFromShopifyPayload {
  @Field(() => Int, { description: 'Discounts with codes the store has.' })
  discounts!: number;

  @Field(() => Int, { description: 'Codes made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, { description: 'Codes left as they are: the shop has codes of theirs.' })
  skipped!: number;

  @Field(() => Int, { description: 'Discounts left out because they ended, or were used up.' })
  expired!: number;

  @Field(() => [StoreDiscountImportError])
  discountErrors!: StoreDiscountImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** A discount as the shop's codes take it, and the store's handles of what it is for. */
type Mapped =
  | {
      ok: true;
      input: Omit<DiscountCodeInput, 'code' | 'productIds' | 'collectionIds'>;
      scope: StoreDiscountItems;
    }
  | { ok: false; message: string };

/**
 * A Shopify store's discount codes through its Admin API (ONB-05, ADR-756): each of a discount's
 * codes made as `discountCodeCreate` makes one, with the discount's value, minimum, dates, what
 * uses it has left and what it is for, found by the products' and collections' handles.
 */
@Resolver()
export class DiscountsFromShopifyResolver {
  constructor(
    private readonly codes: DiscountCodeService,
    private readonly products: ProductService,
    private readonly collections: CollectionService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => DiscountsImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's discount codes through its Admin API (ONB-05, ADR-756): an " +
      'amount or percentage off, free delivery, or buy X get Y at a percentage off; a minimum ' +
      "subtotal; its dates; once per customer; the uses it has left; and the shop's products " +
      'and collections with the handles of those it is for, products bought before it comes. A ' +
      'discount that ended or was used up is left out; one the shop cannot give, such as an ' +
      'amount off each item or one made by an app, is named with why. Codes the shop has are ' +
      'left as they are. Give the store and its app as productsImportFromShopify takes them; ' +
      'the app needs the read_discounts access scope. Nothing given is kept. dryRun reads the ' +
      'store and counts, changing nothing.',
  })
  @RequireScopes('write_discounts')
  async discountsImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<DiscountsImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<DiscountsImportFromShopifyPayload>) =>
      Object.assign(new DiscountsImportFromShopifyPayload(), {
        discounts: 0,
        created: 0,
        skipped: 0,
        expired: 0,
        discountErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreDiscounts(this.shopify.connect(given.shop, given.credentials));
    if (!read.ok) return refused(storeRefusalOf(read));
    const { storeName, currency, discounts } = read.value;
    if (discounts.length === 0) {
      return refused({ field: ['store'], code: 'BLANK', message: `${storeName} has no discounts` });
    }

    const counts = { created: 0, skipped: 0, expired: 0 };
    const discountErrors: StoreDiscountImportError[] = [];
    const failed = (discount: StoreDiscount, message: string) =>
      discountErrors.push(
        Object.assign(new StoreDiscountImportError(), { discount: discount.title, message }),
      );
    for (const discount of discounts) {
      const left = discount.usageLimit === null ? null : discount.usageLimit - discount.used;
      if (discount.status === 'EXPIRED' || (left !== null && left <= 0)) {
        counts.expired++;
        continue;
      }
      const mapped = mappedOf(discount, currency === tenant.currency ? null : currency);
      if (!mapped.ok) {
        failed(discount, mapped.message);
        continue;
      }
      if (discount.codesCount > discount.codes.length) {
        failed(
          discount,
          `It has ${discount.codesCount} codes, of which the first ${discount.codes.length} came`,
        );
      }
      // What it is for, which comes before it in a real import; not looked for in a dry run.
      let scope: Pick<DiscountCodeInput, 'productIds' | 'collectionIds'> = {};
      if (!dry && mapped.scope && 'products' in mapped.scope) {
        const ids = await this.products.idsByHandle(tenant, mapped.scope.products);
        if (ids.size === 0) {
          failed(discount, 'None of the products it is for are in the shop');
          continue;
        }
        scope = { productIds: [...ids.values()] };
      } else if (!dry && mapped.scope && 'collections' in mapped.scope) {
        const ids: string[] = [];
        for (const handle of mapped.scope.collections) {
          const collection = await this.collections.getByHandle(tenant, handle);
          if (collection) ids.push(collection.id);
        }
        if (ids.length === 0) {
          failed(discount, 'None of the collections it is for are in the shop');
          continue;
        }
        scope = { collectionIds: ids };
      }
      for (const code of discount.codes) {
        if (await this.codes.byCode(tenant, code)) {
          counts.skipped++;
          continue;
        }
        if (dry) {
          counts.created++;
          continue;
        }
        const made = await this.codes.create(tenant, {
          ...mapped.input,
          ...scope,
          code,
          ...(left !== null && { usageLimit: left }),
        });
        if (made.ok) counts.created++;
        else failed(discount, `${code}: ${made.errors.map((error) => error.message).join('; ')}`);
      }
    }
    return payload({ discounts: discounts.length, ...counts, discountErrors });
  }
}

/**
 * A discount as the shop's codes take it, or why they cannot: `otherCurrency` is the store's
 * currency where it is not the shop's, in which its amounts would mean something else.
 */
function mappedOf(discount: StoreDiscount, otherCurrency: string | null): Mapped {
  const no = (message: string): Mapped => ({ ok: false, message });
  if (discount.kind === 'DiscountCodeApp') return no('An app made it, which the shop has not');
  if (discount.minimumQuantity !== null) {
    return no("It needs a number of items bought, which the shop's codes do not");
  }
  if (otherCurrency && (discount.amount || discount.minimumSubtotal || discount.buyAmount)) {
    return no(`Its amounts are in ${otherCurrency}`);
  }
  const common = {
    title: discount.title,
    minimumSubtotal: discount.minimumSubtotal,
    startsAt: discount.startsAt ? new Date(discount.startsAt) : null,
    endsAt: discount.endsAt ? new Date(discount.endsAt) : null,
    oncePerCustomer: discount.oncePerCustomer,
  };
  const percent = (fraction: number) => Math.round(fraction * 10_000) / 100;
  switch (discount.kind) {
    case 'DiscountCodeFreeShipping':
      return { ok: true, input: { ...common, freeShipping: true }, scope: null };
    case 'DiscountCodeBasic':
      if (discount.amount !== null) {
        if (discount.amountOnEachItem) {
          return no("It takes an amount off each item, which the shop's codes take off the order");
        }
        return { ok: true, input: { ...common, amount: discount.amount }, scope: discount.items };
      }
      if (discount.percentage !== null) {
        return {
          ok: true,
          input: { ...common, percentage: percent(discount.percentage) },
          scope: discount.items,
        };
      }
      return no('It takes off what the shop cannot read');
    case 'DiscountCodeBxgy': {
      if (discount.buyAmount !== null || discount.buyQuantity === null) {
        return no("It asks an amount bought, which the shop's buy X get Y codes do not");
      }
      if (discount.percentage === null || discount.getQuantity === null) {
        return no("It takes an amount off what is given, which the shop's codes do not");
      }
      const all = (items: StoreDiscountItems) => items === null || 'all' in items;
      const same = JSON.stringify(discount.buyItems) === JSON.stringify(discount.items);
      if (!same && !all(discount.buyItems) && !all(discount.items)) {
        return no("It gives other items than those bought, which the shop's codes do not");
      }
      return {
        ok: true,
        input: {
          ...common,
          percentage: percent(discount.percentage),
          buyQuantity: discount.buyQuantity,
          getQuantity: discount.getQuantity,
        },
        scope: all(discount.buyItems) ? discount.items : discount.buyItems,
      };
    }
    default:
      return no('It is of a kind the shop has not');
  }
}
