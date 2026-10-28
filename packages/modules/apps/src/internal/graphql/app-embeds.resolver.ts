import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
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
import { AppEmbedService, type AppEmbedRecord } from '../app-embeds.service.js';

@ObjectType({
  description:
    "A script an app offers the shop's storefront, as a theme app embed (DEV-06, ADR-852): " +
    'loaded on its pages once the owner or a manager turns it on.',
})
export class AppEmbed {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The app offering it.' })
  appId!: string;

  @Field()
  appName!: string;

  @Field({ description: 'The app\'s own name for it, unique among its scripts: "reviews-widget".' })
  handle!: string;

  @Field()
  name!: string;

  @Field({ description: 'Its https address, loaded async on every storefront page.' })
  src!: string;

  @Field({ description: 'Whether the storefront loads it: off until the shop turns it on.' })
  enabled!: boolean;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class AppEmbedInput {
  @Field()
  handle!: string;

  @Field()
  name!: string;

  @Field()
  src!: string;
}

@ObjectType()
export class AppEmbedPayload {
  @Field(() => AppEmbed, { nullable: true })
  appEmbed!: AppEmbed | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AppEmbedDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedAppEmbedId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toEmbed = (record: AppEmbedRecord) =>
  Object.assign(new AppEmbed(), {
    ...record,
    id: toPublicId('appEmbed', record.id),
    appId: toPublicId('accessToken', record.appId),
  });

const payload = (result: Awaited<ReturnType<AppEmbedService['set']>>) =>
  Object.assign(new AppEmbedPayload(), {
    appEmbed: result.ok ? toEmbed(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });

/** Apps' storefront scripts (ADR-852): offered by apps, turned on by the shop. */
@Resolver(() => AppEmbed)
export class AppEmbedResolver {
  constructor(private readonly embeds: AppEmbedService) {}

  @Query(() => [AppEmbed], {
    description: "The calling app's storefront scripts; for staff, every app's the shop has.",
  })
  @RequireScopes('read_themes')
  async appEmbeds(@CurrentTenant() tenant: TenantContext): Promise<AppEmbed[]> {
    return (await this.embeds.list(tenant)).map(toEmbed);
  }

  @Mutation(() => AppEmbedPayload, {
    description:
      "Offers the calling app's storefront script, or changes it by its handle. Off until the " +
      'shop turns it on, and off again when its address changes.',
  })
  @RequireScopes('write_themes')
  async appEmbedSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: AppEmbedInput,
  ): Promise<AppEmbedPayload> {
    return payload(await this.embeds.set(tenant, input));
  }

  @Mutation(() => AppEmbedDeletePayload, {
    description: "Takes back the calling app's storefront script.",
  })
  @RequireScopes('write_themes')
  async appEmbedDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('handle') handle: string,
  ): Promise<AppEmbedDeletePayload> {
    const result = await this.embeds.remove(tenant, handle);
    return Object.assign(new AppEmbedDeletePayload(), {
      deletedAppEmbedId: result.ok ? toPublicId('appEmbed', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AppEmbedPayload, {
    description: "Turns an app's storefront script on or off: the owner's and managers' to do.",
  })
  @RequireScopes('write_themes')
  async appEmbedEnable(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('enabled') enabled: boolean,
  ): Promise<AppEmbedPayload> {
    const uuid = tryFromPublicId(id, 'appEmbed');
    if (!uuid) {
      return payload(failOne<AppEmbedRecord>(['id'], 'NOT_FOUND', 'No app offers this script'));
    }
    return payload(await this.embeds.enable(tenant, uuid, enabled));
  }
}
