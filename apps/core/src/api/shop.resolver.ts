import {
  CurrencyCode,
  CurrentTenant,
  RequireScopes,
  StorefrontSite,
  badUserInput,
  shopProfile,
  type TenantContext,
} from '@hatti/api';
import { DeliveryService } from '@hatti/checkout/public';
import { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { formatMoney, money, type CurrencyCode as Currency } from '@hatti/money';
import {
  DomainService,
  PolicyService,
  ShopPolicy,
  ShopPolicyDraft,
  ShopPolicyType,
  policyDraft,
  shopPreferencesOf,
  toShopPolicy,
  type PolicyLocale,
} from '@hatti/online-store/public';
import {
  Args,
  Field,
  ID,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({ description: 'The shop that the access token belongs to.' })
export class Shop {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({
    description:
      'Names the storefront on the platform, as "zari" does for zari.hatti.pk. Given when the ' +
      'shop is made; it does not change.',
  })
  handle!: string;

  @Field({
    description:
      "The storefront's address: at the shop's primary domain, such as https://www.zari.pk, or " +
      'else at its handle, such as https://zari.hatti.pk.',
  })
  url!: string;

  @Field(() => CurrencyCode)
  currencyCode!: string;

  @Field({ description: 'IANA time zone, e.g. Asia/Karachi.' })
  timezone!: string;
}

@Resolver(() => Shop)
export class ShopResolver {
  constructor(
    private readonly db: Database,
    private readonly storefronts: StorefrontSite,
    private readonly domains: DomainService,
    private readonly policies: PolicyService,
    private readonly delivery: DeliveryService,
  ) {}

  @Query(() => Shop, { description: 'The shop of the current access token.' })
  async shop(@CurrentTenant() tenant: TenantContext): Promise<Shop> {
    // One query at a time: a transaction's connection runs them in turn.
    const [row, primary] = await this.db.tenant(
      tenant.shopId,
      async (tx) =>
        [
          await shopProfile(tx, tenant.shopId),
          await this.domains.primaryOf(tx, tenant.shopId),
        ] as const,
    );
    return Object.assign(new Shop(), {
      id: toPublicId('shop', row.id),
      name: row.name,
      handle: row.handle,
      url: primary ? this.storefronts.urlAt(primary) : this.storefronts.url(row.handle),
      currencyCode: row.currency,
      timezone: row.timezone,
    });
  }

  @ResolveField(() => [ShopPolicy], {
    description: "Its policies, as the storefront shows them at /policies/, in Shopify's order.",
  })
  @RequireScopes('read_legal_policies')
  async shopPolicies(
    @Parent() shop: Shop,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ShopPolicy[]> {
    return (await this.policies.list(tenant)).map((record) => toShopPolicy(record, shop.url));
  }

  @Query(() => ShopPolicyDraft, {
    description:
      "A first draft of one of the shop's policies, in English or Urdu, filled in from what it " +
      'has set: its name, address, WhatsApp number and delivery charges. It is not saved: read ' +
      'it, change it, and save it with shopPolicyUpdate. Not legal advice.',
  })
  @RequireScopes('read_legal_policies')
  async shopPolicyDraft(
    @CurrentTenant() tenant: TenantContext,
    @Args('type', { type: () => ShopPolicyType }) type: ShopPolicyType,
    @Args('locale', { defaultValue: 'en', description: 'en or ur.' }) locale: string,
  ): Promise<ShopPolicyDraft> {
    if (locale !== 'en' && locale !== 'ur') {
      throw badUserInput('Drafts are written in English (en) or Urdu (ur)');
    }
    const facts = await this.db.tenant(tenant.shopId, async (tx) => {
      const profile = await shopProfile(tx, tenant.shopId);
      const primary = await this.domains.primaryOf(tx, tenant.shopId);
      const preferences = await shopPreferencesOf(tx, tenant.shopId);
      const delivery = await this.delivery.settingsOf(tx, tenant.shopId);
      const rupees = (amount: bigint) =>
        formatMoney(money(amount, profile.currency as Currency), { decimals: 'never' });
      return {
        shopName: profile.name,
        storefrontUrl: primary
          ? this.storefronts.urlAt(primary)
          : this.storefronts.url(profile.handle),
        whatsapp: preferences.whatsappNumber,
        deliveryCharge: rupees(delivery.charge),
        deliveryFree: delivery.charge === 0n,
        freeDeliveryFrom: delivery.freeAbove === null ? null : rupees(delivery.freeAbove),
        zones: delivery.zones.map((zone) => ({
          name: zone.name,
          cities: zone.cities,
          charge: rupees(zone.charge),
        })),
      };
    });
    const draft = policyDraft(type, locale as PolicyLocale, facts);
    return Object.assign(new ShopPolicyDraft(), { type, ...draft });
  }
}
