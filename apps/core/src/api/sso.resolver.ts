import {
  CurrentTenant,
  DnsLookup,
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
    "One of the shop's email domains, and whether DNS proved it the shop's (ADR-919): a TXT record " +
    'of `proofRecord` at `recordName`.',
})
export class ShopSsoDomain {
  @Field()
  domain!: string;

  @Field({ description: 'Where the TXT record goes: _hatti-sso.zari.pk.' })
  recordName!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: "When DNS proved it the shop's; null while not yet.",
  })
  provedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      "Since when a proved domain's record is gone from DNS, as Hatti looks it up again each day " +
      "(ADR-934): three days on, it is no longer proved the shop's. Null while it is there.",
  })
  missingSince!: Date | null;
}

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

  @Field(() => [ShopSsoDomain], {
    description:
      "Each email domain, proved the shop's through DNS or not. A proved domain is the shop's " +
      'alone: sign-ins by email of it come here, and no other shop names it.',
  })
  domains!: ShopSsoDomain[];

  @Field({ description: "The TXT record's value that proves a domain the shop's." })
  proofRecord!: string;

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
    private readonly dns: DnsLookup,
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

  @Mutation(() => ShopSsoPayload, {
    description:
      "Looks in DNS for the shop's TXT record at each of its email domains not yet proved: one " +
      "that shows it is proved the shop's, unless another shop proved it first. The owner alone.",
  })
  @RequireScopes('write_settings')
  async shopSsoDomainsCheck(@CurrentTenant() tenant: TenantContext): Promise<ShopSsoPayload> {
    owning(tenant);
    const before = await this.sso.settingsOf(tenant.shopId);
    const after = await this.sso.proveDomains(tenant.shopId, (host) => this.dns.texts(host));
    const proved = (after?.domains ?? [])
      .filter(
        (each) =>
          each.provedAt && !before?.domains.find((was) => was.domain === each.domain)?.provedAt,
      )
      .map((each) => each.domain);
    if (proved.length > 0) await this.#audit(tenant, 'sso.domains_proved', { domains: proved });
    return Object.assign(new ShopSsoPayload(), {
      sso: after ? this.#toSso(after) : null,
      userErrors: after ? [] : [UserError.of(null, 'NOT_FOUND', 'Set up single sign-on first')],
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
