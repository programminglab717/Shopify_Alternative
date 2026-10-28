import {
  CurrentTenant,
  PublicSite,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  actorColumnsOf,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { ShopSsoService, type ShopSsoSettings } from '@hatti/identity/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({
  description:
    "The shop's single sign-on (ADM-09, ADR-864): the organisation's identity provider, any that " +
    "speaks OpenID Connect, which signs in the shop's staff whose emails are of its domains.",
})
export class ShopSso {
  @Field({ description: "The provider's issuer: https://login.microsoftonline.com/<tenant>/v2.0." })
  issuer!: string;

  @Field()
  clientId!: string;

  @Field({ description: "The client secret's last four characters." })
  secretHint!: string;

  @Field(() => [String])
  emailDomains!: string[];

  @Field({ description: 'Its members other than the owner reach the shop only through it.' })
  required!: boolean;

  @Field({
    description: 'The provider asks for a second factor itself: its sign-ins count as two-step.',
  })
  providerMfa!: boolean;

  @Field({ description: 'Where the provider sends staff back: register it there.' })
  callbackUrl!: string;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class ShopSsoInput {
  @Field()
  issuer!: string;

  @Field()
  clientId!: string;

  @Field(() => String, { nullable: true, description: 'Needed the first time; blank keeps it.' })
  clientSecret?: string | null;

  @Field(() => [String])
  emailDomains!: string[];

  @Field()
  required!: boolean;

  @Field()
  providerMfa!: boolean;
}

@ObjectType()
export class ShopSsoPayload {
  @Field(() => ShopSso, { nullable: true })
  sso!: ShopSso | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** The shop's owner, acting: only they set how its staff sign in, never apps. */
function owning(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner sets its single sign-on.");
  }
}

/** The shop's single sign-on, set by its owner alone (ADR-864). */
@Resolver()
export class ShopSsoResolver {
  constructor(
    private readonly sso: ShopSsoService,
    private readonly site: PublicSite,
    private readonly db: Database,
  ) {}

  @Query(() => ShopSso, {
    nullable: true,
    description: "The shop's single sign-on; null while it has none. The owner alone.",
  })
  @RequireScopes('read_settings')
  async shopSso(@CurrentTenant() tenant: TenantContext): Promise<ShopSso | null> {
    owning(tenant);
    const settings = await this.sso.settingsOf(tenant.shopId);
    return settings && this.#toSso(settings);
  }

  @Mutation(() => ShopSsoPayload, {
    description:
      "Sets the shop's identity provider and its staff's email domains, or changes them. The " +
      'owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async shopSsoUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ShopSsoInput,
  ): Promise<ShopSsoPayload> {
    owning(tenant);
    const result = await this.sso.save(tenant.shopId, input);
    if (result.ok) {
      await this.#audit(tenant, 'sso.updated', {
        issuer: result.value.issuer,
        emailDomains: result.value.emailDomains,
        required: result.value.required,
      });
    }
    return Object.assign(new ShopSsoPayload(), {
      sso: result.ok ? this.#toSso(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => Boolean, {
    description: "Ends the shop's single sign-on: staff sign in their own ways again.",
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async shopSsoDelete(@CurrentTenant() tenant: TenantContext): Promise<boolean> {
    owning(tenant);
    const removed = await this.sso.remove(tenant.shopId);
    if (removed) await this.#audit(tenant, 'sso.deleted', {});
    return removed;
  }

  #toSso(settings: ShopSsoSettings): ShopSso {
    return Object.assign(new ShopSso(), {
      ...settings,
      callbackUrl: this.site.url('/auth/sso/callback'),
    });
  }

  async #audit(tenant: TenantContext, action: string, details: Record<string, unknown>) {
    await this.db.tenant(tenant.shopId, (tx) =>
      recordAudit(tx, tenant.shopId, {
        action,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details,
      }),
    );
  }
}
