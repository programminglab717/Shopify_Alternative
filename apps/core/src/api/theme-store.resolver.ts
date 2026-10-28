import {
  CurrentTenant,
  Money,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { BillingService } from '@hatti/billing/public';
import { AuthError, PartnerThemesService, type ThemeListingRecord } from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { OnlineStoreTheme, THEME_LIMITS, ThemeService, toTheme } from '@hatti/online-store/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({
  description:
    "A theme of the theme store (OS-20, ADR-853): one of Hatti's themes with a designer's own " +
    'files over it, free or for a price in rupees.',
})
export class ThemeListing {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  description!: string;

  @Field({ description: "The designer's business." })
  designer!: string;

  @Field({ description: "Hatti's theme it is built on." })
  base!: string;

  @Field(() => Money, { description: 'What it costs; nothing for a free theme.' })
  price!: Money;

  @Field()
  free!: boolean;

  @Field({ description: 'Whether the shop bought it, to install as often as it likes.' })
  bought!: boolean;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class ThemeStoreInstallPayload {
  @Field(() => OnlineStoreTheme, { nullable: true, description: 'The theme made, not published.' })
  theme!: OnlineStoreTheme | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ThemeStoreBuyPayload {
  @Field(() => ID, { nullable: true, description: 'The invoice to pay with billingInvoicePay.' })
  invoiceId!: string | null;

  @Field(() => Money, { nullable: true, description: 'What the invoice asks, its tax included.' })
  amount!: Money | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class ThemeStoreOfferInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ description: 'Whole rupees: "0" for a free theme, else 1,000 to 100,000.' })
  price!: string;
}

@ObjectType()
export class ThemeStoreOfferPayload {
  @Field(() => ThemeListing, { nullable: true })
  listing!: ThemeListing | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const rupees = (paisa: bigint) => Money.from(money(paisa, 'PKR'));

const toListing = (record: ThemeListingRecord, bought: boolean) =>
  Object.assign(new ThemeListing(), {
    id: toPublicId('themeListing', record.id),
    name: record.name,
    description: record.description,
    designer: record.designer,
    base: record.base,
    price: rupees(record.price),
    free: record.price === 0n,
    bought,
    updatedAt: record.updatedAt,
  });

/**
 * The theme store (OS-20, ADR-853): the core puts together the designers' themes, which identity
 * keeps, the shop's purchases, which billing keeps as invoices, and its themes, which the online
 * store keeps. A designer offers a theme from their development store through its own Admin API.
 */
@Resolver(() => ThemeListing)
export class ThemeStoreResolver {
  constructor(
    private readonly listings: PartnerThemesService,
    private readonly billing: BillingService,
    private readonly themes: ThemeService,
  ) {}

  @Query(() => [ThemeListing], { description: "The theme store's themes, the latest first." })
  @RequireScopes('read_themes')
  async themeStore(@CurrentTenant() tenant: TenantContext): Promise<ThemeListing[]> {
    const [listed, bought] = await Promise.all([
      this.listings.listed(),
      this.billing.themesBoughtOf(tenant.shopId),
    ]);
    return listed.map((record) => toListing(record, bought.has(record.id)));
  }

  @Mutation(() => ThemeStoreInstallPayload, {
    description:
      "Installs a theme of the store as one of the shop's, not published: a free one, or one the " +
      'shop bought, as often as it likes.',
  })
  @RequireScopes('write_themes')
  async themeStoreInstall(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThemeStoreInstallPayload> {
    const result = await this.#install(tenant, tryFromPublicId(id, 'themeListing'));
    return Object.assign(new ThemeStoreInstallPayload(), {
      theme: result.ok ? result.value : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemeStoreBuyPayload, {
    description:
      'Chooses a paid theme of the store to buy: an invoice, paid with billingInvoicePay, after ' +
      'which the shop installs it. The owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async themeStoreBuy(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThemeStoreBuyPayload> {
    if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
      throw deniedToRole("Access denied. Only the shop's owner buys themes.");
    }
    const uuid = tryFromPublicId(id, 'themeListing');
    const listing = uuid ? await this.listings.listing(uuid) : null;
    const result = listing
      ? await this.billing.buyTheme(tenant, {
          id: listing.id,
          name: listing.name,
          price: listing.price,
        })
      : failOne<never>(['id'], 'NOT_FOUND', 'The theme store has no such theme');
    return Object.assign(new ThemeStoreBuyPayload(), {
      invoiceId: result.ok ? toPublicId('billingInvoice', result.value.invoice.id) : null,
      amount: result.ok ? rupees(result.value.invoice.amount) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemeStoreOfferPayload, {
    description:
      'Offers a theme of this development store to the theme store, copied as it is now, or ' +
      "offers it anew: the partner's who built the store alone. It waits for Hatti to look at it.",
  })
  @RequireScopes('read_themes')
  async themeStoreOffer(
    @CurrentTenant() tenant: TenantContext,
    @Args('themeId', { type: () => ID }) themeId: string,
    @Args('input') input: ThemeStoreOfferInput,
  ): Promise<ThemeStoreOfferPayload> {
    if (tenant.actor.kind !== 'staff') {
      throw deniedToRole('Access denied. A partner offers their themes themselves.');
    }
    const fail = (field: string[], message: string) =>
      Object.assign(new ThemeStoreOfferPayload(), {
        listing: null,
        userErrors: UserError.list([{ field, code: 'INVALID', message }]),
      });
    const price = /^[0-9]{1,6}$/.test(input.price.trim())
      ? BigInt(input.price.trim()) * 100n
      : null;
    if (price === null) return fail(['input', 'price'], 'Give the price in whole rupees');
    const uuid = tryFromPublicId(themeId, 'theme');
    const theme = uuid ? await this.themes.get(tenant, uuid) : null;
    if (!theme) return fail(['themeId'], 'Theme not found');
    const files = await this.themes.files(tenant, theme.id);
    try {
      const listing = await this.listings.offer(tenant.actor.userId, {
        shopId: tenant.shopId,
        themeId: theme.id,
        name: input.name,
        description: input.description ?? '',
        price,
        base: theme.base,
        files: files.map((file) => ({ filename: file.filename, body: file.body })),
      });
      return Object.assign(new ThemeStoreOfferPayload(), {
        listing: toListing(listing, false),
        userErrors: [],
      });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (error.status === 403) throw deniedToRole(`Access denied. ${error.message}.`);
      return fail(['input'], error.message);
    }
  }

  async #install(
    tenant: TenantContext,
    id: string | null,
  ): Promise<MutationResult<OnlineStoreTheme>> {
    const bought = id ? (await this.billing.themesBoughtOf(tenant.shopId)).has(id) : false;
    const listing = id ? await this.listings.listing(id, { evenUnlisted: bought }) : null;
    if (!listing) return failOne(['id'], 'NOT_FOUND', 'The theme store has no such theme');
    if (listing.price > 0n && !bought) {
      return failOne(['id'], 'INVALID', 'Buy the theme first: it is paid for once, then yours');
    }
    const made = await this.themes.create(tenant, { name: listing.name, base: listing.base });
    if (!made.ok) return made;
    for (let at = 0; at < listing.files.length; at += THEME_LIMITS.filesPerCall) {
      const saved = await this.themes.upsertFiles(
        tenant,
        made.value.id,
        listing.files.slice(at, at + THEME_LIMITS.filesPerCall),
      );
      if (!saved.ok) {
        // A theme that would not take its files is not left half made.
        await this.themes.delete(tenant, made.value.id);
        return failOne(['id'], 'INVALID', "The theme's files don't fit Hatti's theme any more");
      }
    }
    const theme = await this.themes.get(tenant, made.value.id);
    return { ok: true, value: toTheme(theme ?? made.value) };
  }
}
