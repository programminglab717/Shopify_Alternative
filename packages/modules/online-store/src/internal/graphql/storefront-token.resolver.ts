import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
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
import {
  STOREFRONT_TOKEN_LIMITS,
  StorefrontTokenService,
  type StorefrontTokenRecord,
} from '../storefront-tokens.js';
import { uuidOf } from './mappers.js';

@ObjectType({
  description:
    'A token the Storefront API answers a headless storefront or shopping app by (DEV-02, ' +
    "ADR-848), as Shopify's StorefrontAccessToken: public, sent from shoppers' browsers in " +
    'X-Shopify-Storefront-Access-Token, or private, kept on a server and sent in ' +
    'Shopify-Storefront-Private-Token.',
})
export class StorefrontAccessToken {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Kept on a server, never sent from a page.' })
  private!: boolean;

  @Field({ description: 'Its last four characters, to tell it by.' })
  hint!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The token itself: given once, as it is made, and null after.',
  })
  accessToken!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class StorefrontAccessTokenInput {
  @Field({ description: `What uses it, in ${STOREFRONT_TOKEN_LIMITS.title} characters at most.` })
  title!: string;

  @Field({ nullable: true, defaultValue: false, description: 'A private token; public if not.' })
  private?: boolean;
}

@ObjectType()
export class StorefrontAccessTokenCreatePayload {
  @Field(() => StorefrontAccessToken, { nullable: true })
  storefrontAccessToken!: StorefrontAccessToken | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class StorefrontAccessTokenDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedStorefrontAccessTokenId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toToken = (record: StorefrontTokenRecord, accessToken: string | null = null) =>
  Object.assign(new StorefrontAccessToken(), {
    id: toPublicId('storefrontAccessToken', record.id),
    title: record.title,
    private: record.kind === 'private',
    hint: record.hint,
    accessToken,
    createdAt: record.createdAt,
  });

/** The shop's Storefront API tokens (ADR-848), kept by those who change its settings. */
@Resolver(() => StorefrontAccessToken)
export class StorefrontTokenResolver {
  constructor(private readonly tokens: StorefrontTokenService) {}

  @Query(() => [StorefrontAccessToken], {
    description: "The shop's Storefront API tokens, oldest first.",
  })
  @RequireScopes('read_settings')
  async storefrontAccessTokens(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<StorefrontAccessToken[]> {
    return (await this.tokens.list(tenant)).map((record) => toToken(record));
  }

  @Mutation(() => StorefrontAccessTokenCreatePayload, {
    description: `A new Storefront API token, given once; ${STOREFRONT_TOKEN_LIMITS.perShop} a shop at most.`,
  })
  @RequireScopes('write_settings')
  async storefrontAccessTokenCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: StorefrontAccessTokenInput,
  ): Promise<StorefrontAccessTokenCreatePayload> {
    const result = await this.tokens.create(tenant, {
      title: input.title,
      kind: input.private ? 'private' : 'public',
    });
    return Object.assign(new StorefrontAccessTokenCreatePayload(), {
      storefrontAccessToken: result.ok
        ? toToken(result.value.record, result.value.accessToken)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => StorefrontAccessTokenDeletePayload, {
    description: 'Deletes a Storefront API token: it stops working a moment later.',
  })
  @RequireScopes('write_settings')
  async storefrontAccessTokenDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<StorefrontAccessTokenDeletePayload> {
    const result = await this.tokens.delete(tenant, uuidOf('storefrontAccessToken', id));
    return Object.assign(new StorefrontAccessTokenDeletePayload(), {
      deletedStorefrontAccessTokenId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
